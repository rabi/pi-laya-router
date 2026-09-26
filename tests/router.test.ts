import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRouterCommand } from "../extensions/laya-router/commands.ts";
import { RouterState } from "../extensions/laya-router/router.ts";
import { calibratedSwitchDefaults } from "../extensions/laya-router/types.ts";
import { validate } from "../extensions/laya-router/config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { RouterConfig, ThinkingLevel } from "../extensions/laya-router/types.ts";

const CFG: RouterConfig = {
	serveUrl: "http://test:8000",
	minConfidence: 0.5,
	defaultRoute: "quick",
	routes: {
		quick: { provider: "openai", model: "mini", description: "simple" },
		code: { provider: "anthropic", model: "opus", description: "coding", thinkingLevel: "high" },
	},
};

const BIG = "x".repeat(120000); // ~30k tokens — clears the 20k keepRecentTokens budget

/** Build a mock session projection: `turns` user/assistant pairs, each user msg sized to clear the compaction budget. */
function projectionFor(turns: number, content = BIG) {
	const entries = [];
	for (let i = 0; i < turns; i++) {
		entries.push({ sourceEntry: { type: "message" }, messages: [{ role: "user", content }] });
		entries.push({ sourceEntry: { type: "message" }, messages: [{ role: "assistant", content: "ok" }] });
	}
	return { entries };
}

function mockCtx(model?: Model<any>, projection: ReturnType<typeof projectionFor> = projectionFor(2)) {
	const notifications: [string, string?][] = [];
	const compactCalls: any[] = [];
	const ctx = {
		model,
		ui: { notify: (msg: string, level?: string) => notifications.push([msg, level]) },
		modelRegistry: {
			find: (provider: string, id: string) => ({ id, provider }) as Model<any>,
		},
		sessionManager: { buildSessionProjection: () => projection },
		compact: (opts?: any) => { compactCalls.push(opts); },
	} as unknown as ExtensionContext;
	return { ctx, notifications, compactCalls };
}

const getThinking = (level: ThinkingLevel): (() => ThinkingLevel) => () => level;

function stubAnswer(choice: string, confidence: number) {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ answers: { route: { choice, answer_confidence: confidence } } }), { status: 200 })) as typeof fetch;
	return () => (globalThis.fetch = original);
}

/** Stub a probabilities map (what scoreRoutes reads) for switch-policy tests. */
function stubScores(probs: Record<string, number>, choice?: string) {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({ answers: { route: { choice: choice ?? Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0], probabilities: probs } } }),
			{ status: 200 },
		)) as typeof fetch;
	return () => (globalThis.fetch = original);
}

function stateWith(cfg: RouterConfig) {
	const state = new RouterState();
	state.cfg = structuredClone(cfg);
	return state;
}

// keep every test's default decision log out of the real agent dir
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "agentdir-"));
});
afterEach(() => {
	if (savedAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	else delete process.env.PI_CODING_AGENT_DIR;
});

describe("RouterState.route", () => {
	test("without config returns undefined", async () => {
		const state = new RouterState();
		const { ctx } = mockCtx();
		expect(await state.route(ctx, "hi", mock(async () => true), mock(() => {}), getThinking("off"))).toBeUndefined();
	});

	test("default (intent) switches model and thinking level on decision", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = new RouterState();
		state.cfg = structuredClone(CFG);
		const { ctx } = mockCtx({ id: "mini", provider: "openai" } as Model<any>);
		const setModel = mock(async () => true);
		const setThinking = mock(() => {});

		const d = await state.route(ctx, "implement auth", setModel, setThinking, getThinking("off"));
		expect(d?.decision.bucket).toBe("code");
		expect(d?.switched).toBe(true);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect((setModel.mock.calls[0][0] as Model<any>).id).toBe("opus");
		expect(setThinking.mock.calls[0][0]).toBe("high");
		expect(state.lastDecision).toContain("code (0.90) -> anthropic/opus");
		restore();
	});

	test("same model skips setModel but still applies thinking and decision", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = new RouterState();
		state.cfg = structuredClone(CFG);
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" } as Model<any>);
		const setModel = mock(async () => true);
		const setThinking = mock(() => {});

		const d = await state.route(ctx, "x", setModel, setThinking, getThinking("off"));
		expect(d?.decision.bucket).toBe("code");
		expect(d?.switched).toBe(false);
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinking.mock.calls[0][0]).toBe("high");
		expect(state.lastDecision).toContain("code");
		restore();
	});

	test("missing model in registry warns and skips switch", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = new RouterState();
		state.cfg = structuredClone(CFG);
		const { ctx, notifications } = mockCtx();
		ctx.modelRegistry = { find: () => undefined } as never;
		const setModel = mock(async () => true);

		expect(await state.route(ctx, "x", setModel, mock(() => {}), getThinking("off"))).toBeUndefined();
		expect(setModel).not.toHaveBeenCalled();
		expect(notifications.some(([m]) => m.includes("not found in registry"))).toBe(true);
		restore();
	});

	test("setModel returning false (no API key) warns and skips thinking level", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = new RouterState();
		state.cfg = structuredClone(CFG);
		const { ctx, notifications } = mockCtx();
		const setThinking = mock(() => {});

		expect(await state.route(ctx, "x", mock(async () => false), setThinking, getThinking("off"))).toBeUndefined();
		expect(setThinking).not.toHaveBeenCalled();
		expect(notifications.some(([m]) => m.includes("no API key"))).toBe(true);
		restore();
	});

	test("route without thinkingLevel restores baseline set by an earlier route", async () => {
		const setThinking = mock(() => {});

		const restore1 = stubAnswer("code", 0.9);
		const state = new RouterState();
		state.cfg = structuredClone(CFG);
		const { ctx } = mockCtx(undefined);
		await state.route(ctx, "implement the auth middleware for the api", mock(async () => true), setThinking, getThinking("minimal"));
		restore1();
		expect(setThinking.mock.calls[0][0]).toBe("high");

		const restore2 = stubAnswer("quick", 0.9);
		await state.route(ctx, "summarise the release notes for the blog", mock(async () => true), setThinking, getThinking("minimal"));
		restore2();
		expect(setThinking).toHaveBeenCalledTimes(2);
		expect(setThinking.mock.calls[1][0]).toBe("minimal");
	});
});

describe("manual toggle survives reload", () => {
	let agentDir: string;
	let cwd: string;
	const saved = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "toggle-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "toggle-cwd-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (saved !== undefined) process.env.PI_CODING_AGENT_DIR = saved;
		else delete process.env.PI_CODING_AGENT_DIR;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	test("/laya-router off then reload keeps off; on restores", async () => {
		writeFileSync(
			join(agentDir, "router.json"),
			JSON.stringify({ serveUrl: "http://x:1", routes: { a: { provider: "p", model: "m", description: "d" } }, routing: { enabled: true } }),
		);
		const state = new RouterState();
		const notifications: string[] = [];
		const ctx = { cwd, ui: { notify: (m: string) => notifications.push(m) } } as unknown as ExtensionContext;

		state.reload(cwd);
		expect(state.enabled).toBe(true);

		await handleRouterCommand("off", ctx, state);
		expect(state.enabled).toBe(false);

		await handleRouterCommand("reload", ctx, state);
		expect(state.enabled).toBe(false);

		await handleRouterCommand("on", ctx, state);
		expect(state.enabled).toBe(true);
	});
});

describe("session lock (sticky routing)", () => {
	test("first prompt locks; later prompts are not classified", async () => {
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ answers: { route: { choice: "code", answer_confidence: 0.9 } } }), { status: 200 });
		}) as typeof fetch;
		const state = stateWith({ ...CFG, routing: { stickySession: true } });
		const { ctx } = mockCtx(undefined);
		const setModel = mock(async () => true);

		const first = await state.route(ctx, "implement auth", setModel, mock(() => {}), getThinking("off"));
		expect(first?.decision.bucket).toBe("code");
		expect(await state.route(ctx, "what is the capital of France", setModel, mock(() => {}), getThinking("off"))).toBeUndefined();
		expect(calls).toBe(1);

		state.unlock();
		await state.route(ctx, "what is the capital of France and its largest airport", setModel, mock(() => {}), getThinking("off"));
		expect(calls).toBe(2);
		globalThis.fetch = original;
	});

	test("resetSession clears bucket and mode defaults to intent", () => {
		const state = stateWith(CFG);
		state.currentBucket = "code";
		state.resetSession();
		expect(state.currentBucket).toBeUndefined();
		expect(state.routingMode()).toBe("intent");
	});

	test("switchPolicy:false opts back into classify; stickySession wins over it", () => {
		expect(stateWith({ ...CFG, routing: { switchPolicy: false } }).routingMode()).toBe("classify");
		expect(stateWith({ ...CFG, routing: { stickySession: true, switchPolicy: false } }).routingMode()).toBe("sticky");
	});
});

describe("intent-only routing (switch policy)", () => {
	test("challenger within margin keeps incumbent", async () => {
		const restore = stubScores({ quick: 0.4, code: 0.48 });
		const state = stateWith({ ...CFG, routing: { switchPolicy: { minMargin: 0.15 } } });
		state.currentBucket = "quick";
		const { ctx } = mockCtx({ id: "mini", provider: "openai" } as Model<any>);
		const setModel = mock(async () => true);

		const r = await state.route(ctx, "explain the difference between these two data structures", setModel, mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("quick");
		expect(r?.switched).toBe(false);
		expect(setModel).not.toHaveBeenCalled();
		restore();
	});

	test("challenger beyond margin switches", async () => {
		const restore = stubScores({ quick: 0.2, code: 0.7 });
		const state = stateWith({ ...CFG, routing: { switchPolicy: { minMargin: 0.15 } } });
		state.currentBucket = "quick";
		const { ctx } = mockCtx({ id: "mini", provider: "openai" } as Model<any>);
		const setModel = mock(async () => true);

		const r = await state.route(ctx, "write a recursive descent parser for this grammar", setModel, mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		expect(r?.switched).toBe(true);
		restore();
	});

	test("no confident route keeps incumbent (gated)", async () => {
		const restore = stubScores({ quick: 0.1, code: 0.12 });
		const state = stateWith({ ...CFG, routing: { switchPolicy: { minMargin: 0.15, minAbsolute: 0.3 } } });
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" } as Model<any>);

		const r = await state.route(ctx, "what is the state of things here right now really", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		expect(r?.decision.gated).toBe(true);
		restore();
	});

	test("first prompt with no incumbent routes normally", async () => {
		const restore = stubScores({ quick: 0.2, code: 0.7 });
		const state = stateWith({ ...CFG, routing: { switchPolicy: {} } });
		const { ctx } = mockCtx(undefined);
		const r = await state.route(ctx, "write a parser", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		restore();
	});

	test("incumbent score missing from the map still switches (no margin to compare)", async () => {
		const restore = stubScores({ code: 0.7 }, "code");
		const state = stateWith({ ...CFG, routing: { switchPolicy: { minMargin: 0.15 } } });
		state.currentBucket = "quick";
		const { ctx } = mockCtx({ id: "mini", provider: "openai" });
		const r = await state.route(ctx, "write a tokenizer and parser for a small language", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		expect(r?.switched).toBe(true);
		restore();
	});
});

describe("classify fallback (switchPolicy:false)", () => {
	test("switches on any classification change, no margin gate", async () => {
		const restore = stubScores({ quick: 0.52, code: 0.48 }, "quick");
		const state = stateWith({ ...CFG, routing: { switchPolicy: false } });
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" });
		const r = await state.route(ctx, "give me your best guess on how to proceed here", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("quick");
		expect(r?.switched).toBe(true);
		restore();
	});
});

describe("per-route minScore floor", () => {
	const floorCfg = (floor: number): RouterConfig => ({
		...CFG,
		routes: { ...CFG.routes, code: { ...CFG.routes.code, minScore: floor } },
	});

	test("intent: top route below its floor drops to next-best route, not default", async () => {
		const restore = stubScores({ quick: 0.3, code: 0.4 });
		const state = stateWith({ ...floorCfg(0.5), routing: { switchPolicy: { minMargin: 0.15, minAbsolute: 0.2 } } });
		const { ctx } = mockCtx(undefined);
		const r = await state.route(ctx, "write a parser for the tiny language in this repo", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("quick");
		expect(r?.decision.gated).toBe(true);
		expect(r?.decision.reason).toContain("below its minScore floor");
		restore();
	});

	test("intent: incumbent below its own floor loses margin protection", async () => {
		const restore = stubScores({ quick: 0.45, code: 0.4 });
		const state = stateWith({ ...floorCfg(0.5), routing: { switchPolicy: { minMargin: 0.15, minAbsolute: 0.2 } } });
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" } as Model<any>);
		const setModel = mock(async () => true);
		const r = await state.route(ctx, "explain how the parser handles this grammar", setModel, mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("quick");
		expect(r?.switched).toBe(true);
		expect(setModel).toHaveBeenCalledTimes(1);
		restore();
	});

	test("intent: incumbent above its floor keeps margin protection", async () => {
		const restore = stubScores({ quick: 0.45, code: 0.55 });
		const state = stateWith({ ...floorCfg(0.5), routing: { switchPolicy: { minMargin: 0.15, minAbsolute: 0.2 } } });
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" } as Model<any>);
		const setModel = mock(async () => true);
		const r = await state.route(ctx, "explain how the parser handles this grammar", setModel, mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		expect(r?.switched).toBe(false);
		expect(setModel).not.toHaveBeenCalled();
		restore();
	});

	test("intent: no route clears its floor keeps incumbent", async () => {
		const restore = stubScores({ quick: 0.1, code: 0.2 });
		const state = stateWith({
			...CFG,
			routing: { switchPolicy: { minMargin: 0.15, minAbsolute: 0.05 } },
			routes: { quick: { ...CFG.routes.quick, minScore: 0.15 }, code: { ...CFG.routes.code, minScore: 0.5 } },
		});
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" } as Model<any>);
		const r = await state.route(ctx, "what is the current state of the parser work here", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		expect(r?.decision.gated).toBe(true);
		restore();
	});

	test("classify: floor demotes choice to next-best from probabilities", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ answers: { route: { choice: "code", answer_confidence: 0.45, probabilities: { quick: 0.4, code: 0.45 } } } }), { status: 200 })) as typeof fetch;
		const state = stateWith({ ...floorCfg(0.5), minConfidence: 0.3, routing: { switchPolicy: false } });
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" });
		const r = await state.route(ctx, "give me your best guess on how to proceed here", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("quick");
		expect(r?.decision.gated).toBe(true);
		globalThis.fetch = original;
	});

	test("classify: no other eligible route falls back to defaultRoute", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ answers: { route: { choice: "code", answer_confidence: 0.45, probabilities: { quick: 0.1, code: 0.45 } } } }), { status: 200 })) as typeof fetch;
		const state = stateWith({
			...CFG,
			minConfidence: 0.3,
			routing: { switchPolicy: false },
			routes: { quick: { ...CFG.routes.quick, minScore: 0.15 }, code: { ...CFG.routes.code, minScore: 0.5 } },
		});
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" });
		const r = await state.route(ctx, "give me your best guess on how to proceed here", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("quick");
		expect(r?.decision.gated).toBe(true);
		globalThis.fetch = original;
	});

	test("validate rejects minScore outside [0,1]", () => {
		expect(() => validate({ ...CFG, routes: { ...CFG.routes, code: { ...CFG.routes.code, minScore: 1.5 } } })).toThrow(/minScore/);
		expect(() => validate({ ...CFG, routes: { ...CFG.routes, code: { ...CFG.routes.code, minScore: -0.1 } } })).toThrow(/minScore/);
		expect(() => validate(floorCfg(0.5))).not.toThrow();
	});
});

describe("small-signal switch gate (minSwitchChars)", () => {
	test("tiny followup with incumbent: no laya call, incumbent held", async () => {
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ answers: { route: { choice: "quick", answer_confidence: 0.9 } } }), { status: 200 });
		}) as typeof fetch;
		const state = stateWith(CFG);
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" });

		const r = await state.route(ctx, "yes, do it", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r).toBeUndefined();
		expect(calls).toBe(0);
		expect(state.currentBucket).toBe("code");
		expect(state.lastDecision).toContain("held code");
		globalThis.fetch = original;
	});

	test("data-heavy paste: code stripped, prose below gate, incumbent held", async () => {
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ answers: { route: { choice: "quick", answer_confidence: 0.9 } } }), { status: 200 });
		}) as typeof fetch;
		const state = stateWith(CFG);
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" });

		const log = "2026-02-06 ERROR auth middleware: token expired at 12:00:01\n".repeat(200);
		await state.route(ctx, `here is the log:\n\`\`\`${log}\`\`\`\nanalyze this`, mock(async () => true), mock(() => {}), getThinking("off"));
		expect(calls).toBe(0);
		expect(state.currentBucket).toBe("code");
		globalThis.fetch = original;
	});

	test("tiny first prompt (no incumbent) still routes", async () => {
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ answers: { route: { choice: "code", answer_confidence: 0.9 } } }), { status: 200 });
		}) as typeof fetch;
		const state = stateWith(CFG);
		const { ctx } = mockCtx(undefined);

		const r = await state.route(ctx, "code it", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(calls).toBe(1);
		expect(r?.decision.bucket).toBe("code");
		globalThis.fetch = original;
	});

	test("minSwitchChars: 0 disables the gate", async () => {
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(JSON.stringify({ answers: { route: { choice: "quick", answer_confidence: 0.9 } } }), { status: 200 });
		}) as typeof fetch;
		const state = stateWith({ ...CFG, routing: { minSwitchChars: 0 } });
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" });

		await state.route(ctx, "yes", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(calls).toBe(1);
		globalThis.fetch = original;
	});
});

describe("model switch triggers compaction", () => {
	test("switch calls ctx.compact and sets compactingForSwitch", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, provider: "openai", model: "cheap" } } });
		state.summarize = async () => ({ summary: "S", usage: undefined });
		const { ctx, compactCalls } = mockCtx({ id: "mini", provider: "openai" } as Model<any>);
		const setModel = mock(async () => true);

		const r = await state.route(ctx, "write a parser", setModel, mock(() => {}), getThinking("off"));
		expect(r?.switched).toBe(true);
		expect(state.compactingForSwitch).toBe(true);
		expect(compactCalls).toHaveLength(1);
		expect(compactCalls[0].customInstructions).toContain("Model switch");
		compactCalls[0].onError(new Error("Nothing to compact (session too small)"));
		expect(state.compactingForSwitch).toBe(false);
		restore();
	});

	test("single-turn session does not trigger compaction", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, provider: "openai", model: "cheap" } } });
		state.summarize = async () => ({ summary: "S", usage: undefined });
		const { ctx, compactCalls } = mockCtx({ id: "mini", provider: "openai" } as Model<any>, projectionFor(1));

		const r = await state.route(ctx, "first prompt", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.switched).toBe(true);
		expect(state.compactingForSwitch).toBe(false);
		expect(compactCalls).toHaveLength(0);
		restore();
	});

	test("small history (under keepRecentTokens) does not trigger compaction", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, provider: "openai", model: "cheap" } } });
		const { ctx, compactCalls } = mockCtx({ id: "mini", provider: "openai" } as Model<any>, projectionFor(2, "hi"));

		const r = await state.route(ctx, "first prompt", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.switched).toBe(true);
		expect(state.compactingForSwitch).toBe(false);
		expect(compactCalls).toHaveLength(0);
		restore();
	});

	test("nothing new since last compaction does not trigger compaction", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, provider: "openai", model: "cheap" } } });
		// retained tail after compaction is large, but only one user turn followed it
		const projection = {
			entries: [
				{ sourceEntry: { type: "compaction" }, messages: [{ role: "user", content: BIG }, { role: "assistant", content: "ok" }, { role: "user", content: BIG }] },
				{ sourceEntry: { type: "message" }, messages: [{ role: "user", content: "next question" }] },
			],
		};
		const { ctx, compactCalls } = mockCtx({ id: "mini", provider: "openai" } as Model<any>, projection);

		const r = await state.route(ctx, "first prompt", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.switched).toBe(true);
		expect(state.compactingForSwitch).toBe(false);
		expect(compactCalls).toHaveLength(0);
		restore();
	});

	test("same model does not trigger compaction", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = stateWith(CFG);
		const { ctx, compactCalls } = mockCtx({ id: "opus", provider: "anthropic" } as Model<any>);

		const r = await state.route(ctx, "x", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.switched).toBe(false);
		expect(state.compactingForSwitch).toBe(false);
		expect(compactCalls).toHaveLength(0);
		restore();
	});

	test("resetSession clears compactingForSwitch", () => {
		const state = stateWith(CFG);
		state.compactingForSwitch = true;
		state.resetSession();
		expect(state.compactingForSwitch).toBe(false);
	});

	test("missing model in registry does not trigger compaction", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = stateWith(CFG);
		const { ctx, compactCalls, notifications } = mockCtx({ id: "mini", provider: "openai" } as Model<any>);
		ctx.modelRegistry = { find: () => undefined } as never;

		const r = await state.route(ctx, "x", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r).toBeUndefined();
		expect(compactCalls).toHaveLength(0);
		restore();
	});
});

describe("RouterState.reload", () => {
	test("no config files: cfg undefined, warning notified", () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		const savedCwd = process.env.PWD;
		process.env.PI_CODING_AGENT_DIR = "/nonexistent-agent-dir";
		const state = new RouterState();
		const notifications: string[] = [];
		const ctx = { ui: { notify: (m: string) => notifications.push(m) } } as unknown as ExtensionContext;
		const ok = state.reload("/nonexistent-cwd", ctx);
		expect(ok).toBe(false);
		expect(state.cfg).toBeUndefined();
		// current behavior: enabled defaults true even without config (route() is cfg-guarded)
		expect(state.enabled).toBe(true);
		expect(notifications.some((m) => m.includes("no router.json found"))).toBe(true);
		if (saved !== undefined) process.env.PI_CODING_AGENT_DIR = saved;
		process.env.PWD = savedCwd!;
	});
});

describe("calibrated switch defaults", () => {
	test("scale with route count and stay in sane range", () => {
		expect(calibratedSwitchDefaults(4)).toEqual({ minMargin: 0.0625, minAbsolute: 0.28 });
		expect(calibratedSwitchDefaults(2).minMargin).toBeCloseTo(0.125);
		expect(calibratedSwitchDefaults(2).minAbsolute).toBe(0.4); // clamped
		expect(calibratedSwitchDefaults(16).minMargin).toBe(0.03); // clamped
	});

	test("small margins switch under calibrated defaults where fixed 0.15 held", async () => {
		const CFG4 = {
			...CFG,
			routes: {
				...CFG.routes,
				review: { provider: "openai", model: "mini", description: "review" },
				investigate: { provider: "openai", model: "mini", description: "investigate" },
			},
		};
		// defaults for 4 routes: margin 0.0625, minAbsolute 0.28
		const restore = stubScores({ quick: 0.22, code: 0.34, review: 0.22, investigate: 0.22 });
		const state = stateWith({ ...CFG4, routing: { switchPolicy: {} } });
		state.currentBucket = "quick";
		const { ctx } = mockCtx({ id: "mini", provider: "openai" });
		const r = await state.route(ctx, "explain how the reconciler decides which hosts to provision", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		expect(r?.switched).toBe(true);
		expect(r?.decision.reason).toContain("minMargin");
		restore();
	});

	test("near-uniform scores still gate to incumbent", async () => {
		const restore = stubScores({ quick: 0.24, code: 0.25 });
		const state = stateWith({ ...CFG, routing: { switchPolicy: {} } });
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" });
		const r = await state.route(ctx, "what should we do about this thing here now", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		expect(r?.decision.gated).toBe(true);
		restore();
	});
});

describe("decision log", () => {
	test("switch and hold decisions are appended with reason and probabilities", async () => {
		const dir = mkdtempSync(join(tmpdir(), "decisionlog-"));
		const logPath = join(dir, "decisions.jsonl");
		const restore = stubScores({ quick: 0.2, code: 0.7 });
		const state = stateWith({ ...CFG, routing: { decisionLogPath: logPath } });
		const { ctx } = mockCtx(undefined);
		await state.route(ctx, "write a parser for the config format", mock(async () => true), mock(() => {}), getThinking("off"));

		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines.length).toBe(1);
		const rec = JSON.parse(lines[0]);
		expect(rec.outcome).toBe("switch");
		expect(rec.bucket).toBe("code");
		expect(rec.probabilities).toEqual({ quick: 0.2, code: 0.7 });
		expect(rec.prompt).toContain("write a parser");
		restore();
		rmSync(dir, { recursive: true, force: true });
	});

	test("decisionLog:false disables the log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "decisionlog-"));
		const logPath = join(dir, "decisions.jsonl");
		const restore = stubScores({ quick: 0.2, code: 0.7 });
		const state = stateWith({ ...CFG, routing: { decisionLog: false, decisionLogPath: logPath } });
		const { ctx } = mockCtx(undefined);
		await state.route(ctx, "write a parser for the config format", mock(async () => true), mock(() => {}), getThinking("off"));
		expect(existsSync(logPath)).toBe(false);
		restore();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("session pin", () => {
	test("pin switches immediately, holds across prompts, unpin resumes", async () => {
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: any, init: any) => {
			calls++;
			return new Response(JSON.stringify({ answers: { route: { choice: "quick", probabilities: { quick: 0.6, code: 0.4 } } } }), { status: 200 });
		}) as typeof fetch;
		const state = stateWith(CFG);
		const { ctx } = mockCtx(undefined);
		const notifications: [string, string?][] = [];
		const cmdCtx = { ...ctx, ui: { notify: (m: string, l?: string) => notifications.push([m, l]) } } as unknown as ExtensionContext;
		const models = { setModel: mock(async () => true), setThinkingLevel: mock(() => {}), getThinkingLevel: getThinking("off") };

		await handleRouterCommand("pin code", cmdCtx, state, models);
		expect(state.isPinned()).toBe(true);
		expect((models.setModel.mock.calls[0][0] as Model<any>).id).toBe("opus");

		// pinned: prompts are not classified at all
		const before = calls;
		expect(await state.route(ctx, "what is the capital of France and its airports", models.setModel, models.setThinkingLevel, models.getThinkingLevel)).toBeUndefined();
		expect(calls).toBe(before);
		expect(state.lastDecision).toContain("pinned code");

		await handleRouterCommand("unpin", cmdCtx, state, models);
		expect(state.isPinned()).toBe(false);
		await state.route(ctx, "what is the capital of France and its largest airport", models.setModel, models.setThinkingLevel, models.getThinkingLevel);
		expect(calls).toBe(before + 1);
		globalThis.fetch = original;
	});

	test("pin accepts bare provider/model not in the route table", async () => {
		const state = stateWith(CFG);
		const { ctx } = mockCtx(undefined);
		const models = { setModel: mock(async () => true), setThinkingLevel: mock(() => {}), getThinkingLevel: getThinking("off") };
		await handleRouterCommand("pin anthropic/opus", ctx, state, models);
		expect(state.isPinned()).toBe(true);
		expect(state.pinned).toBe("anthropic/opus");
		expect(state.pinnedRoute).toEqual({ provider: "anthropic", model: "opus" });
	});

	test("pin rejects unknown provider/model pair", async () => {
		const state = stateWith(CFG);
		const { ctx, notifications } = mockCtx(undefined);
		ctx.modelRegistry = { find: () => undefined } as never;
		const models = { setModel: mock(async () => true), setThinkingLevel: mock(() => {}), getThinkingLevel: getThinking("off") };
		await handleRouterCommand("pin ghost/nope", ctx, state, models);
		expect(state.isPinned()).toBe(false);
		expect(notifications.some(([m]) => m.includes("no model ghost/nope in registry"))).toBe(true);
	});

	test("pin with unknown route errors and does not pin", async () => {
		const state = stateWith(CFG);
		const { ctx, notifications } = mockCtx(undefined);
		const models = { setModel: mock(async () => true), setThinkingLevel: mock(() => {}), getThinkingLevel: getThinking("off") };
		await handleRouterCommand("pin nope", ctx, state, models);
		expect(state.isPinned()).toBe(false);
		expect(notifications.some(([m]) => m.includes('no route "nope"'))).toBe(true);
	});

	test("pin failure (no API key) does not pin", async () => {
		const state = stateWith(CFG);
		const { ctx, notifications } = mockCtx(undefined);
		const models = { setModel: mock(async () => false), setThinkingLevel: mock(() => {}), getThinkingLevel: getThinking("off") };
		await handleRouterCommand("pin code", ctx, state, models);
		expect(state.isPinned()).toBe(false);
		expect(notifications.some(([m]) => m.includes("could not switch"))).toBe(true);
	});
});

describe("reroute clears incumbent", () => {
	test("intent mode: reroute drops currentBucket so next prompt routes from scratch", async () => {
		const state = stateWith(CFG);
		state.currentBucket = "code";
		const { ctx } = mockCtx(undefined);
		await handleRouterCommand("reroute", ctx, state);
		expect(state.currentBucket).toBeUndefined();
	});
});

describe("status shows effective policy", () => {
	test("default policy values are reported", async () => {
		const state = stateWith({ ...CFG, routing: {} });
		const { ctx, notifications } = mockCtx(undefined);
		await handleRouterCommand("", ctx, state);
		expect(notifications[0][0]).toContain("minMargin>=0.125 (default)");
		expect(notifications[0][0]).toContain("minAbsolute>=0.400 (default)");
	});

	test("explicit overrides are reported as-is", async () => {
		const state = stateWith({ ...CFG, routing: { switchPolicy: { minMargin: 0.1, minAbsolute: 0.3 } } });
		const { ctx, notifications } = mockCtx(undefined);
		await handleRouterCommand("", ctx, state);
		expect(notifications[0][0]).toContain("minMargin>=0.100");
		expect(notifications[0][0]).toContain("minAbsolute>=0.300");
		expect(notifications[0][0]).not.toContain("minMargin>=0.100 (default)");
	});
});
