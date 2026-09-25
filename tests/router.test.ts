import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRouterCommand } from "../extensions/laya-router/commands.ts";
import { RouterState } from "../extensions/laya-router/router.ts";
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

function mockCtx(model?: Model<any>) {
	const notifications: [string, string?][] = [];
	const ctx = {
		model,
		ui: { notify: (msg: string, level?: string) => notifications.push([msg, level]) },
		modelRegistry: {
			find: (provider: string, id: string) => ({ id, provider }) as Model<any>,
		},
	} as unknown as ExtensionContext;
	return { ctx, notifications };
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

describe("RouterState.route", () => {
	test("without config returns undefined", async () => {
		const state = new RouterState();
		const { ctx } = mockCtx();
		expect(await state.route(ctx, "hi", mock(async () => true), mock(() => {}), getThinking("off"))).toBeUndefined();
	});

	test("switches model and thinking level on decision", async () => {
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
		await state.route(ctx, "hard task", mock(async () => true), setThinking, getThinking("minimal"));
		restore1();
		expect(setThinking.mock.calls[0][0]).toBe("high");

		const restore2 = stubAnswer("quick", 0.9);
		await state.route(ctx, "easy task", mock(async () => true), setThinking, getThinking("minimal"));
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
		await state.route(ctx, "what is the capital of France", setModel, mock(() => {}), getThinking("off"));
		expect(calls).toBe(2);
		globalThis.fetch = original;
	});

	test("resetSession clears bucket and mode defaults to classify", () => {
		const state = stateWith(CFG);
		state.currentBucket = "code";
		state.resetSession();
		expect(state.currentBucket).toBeUndefined();
		expect(state.routingMode()).toBe("classify");
	});
});

describe("intent-only routing (switch policy)", () => {
	test("challenger within margin keeps incumbent", async () => {
		const restore = stubScores({ quick: 0.4, code: 0.48 });
		const state = stateWith({ ...CFG, routing: { switchPolicy: { minMargin: 0.15 } } });
		state.currentBucket = "quick";
		const { ctx } = mockCtx({ id: "mini", provider: "openai" } as Model<any>);
		const setModel = mock(async () => true);

		const r = await state.route(ctx, "slightly technical ask", setModel, mock(() => {}), getThinking("off"));
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

		const r = await state.route(ctx, "write a parser", setModel, mock(() => {}), getThinking("off"));
		expect(r?.decision.bucket).toBe("code");
		expect(r?.switched).toBe(true);
		restore();
	});

	test("no confident route keeps incumbent (gated)", async () => {
		const restore = stubScores({ quick: 0.1, code: 0.12 });
		const state = stateWith({ ...CFG, routing: { switchPolicy: { minMargin: 0.15, minAbsolute: 0.3 } } });
		state.currentBucket = "code";
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" } as Model<any>);

		const r = await state.route(ctx, "hmm", mock(async () => true), mock(() => {}), getThinking("off"));
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
});

describe("stateful summarisation (context transform)", () => {
	function history(pairs: number, chars: number) {
		const msgs: any[] = [];
		for (let i = 0; i < pairs; i++) {
			msgs.push({ role: "user", content: `question ${i} ${"u".repeat(chars)}` });
			msgs.push({ role: "assistant", content: `answer ${i} ${"a".repeat(chars)}` });
		}
		return msgs;
	}

	test("disabled summarizer leaves context untouched", async () => {
		const state = stateWith(CFG);
		expect(await state.transformContext([...history(3, 100), { role: "user", content: "next ask" }])).toBeUndefined();
	});

	test("switch builds digest; request becomes digest + current turn", async () => {
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, minChars: 100 } } });
		let digestCalls = 0;
		(state as any).summarize = async () => {
			digestCalls++;
			return "DIGEST TEXT";
		};
		(state as any).digestPending = true;
		const msgs = [...history(3, 100), { role: "user", content: "next ask" }];

		const out = await state.transformContext(msgs);
		expect(digestCalls).toBe(1);
		expect(out?.messages).toHaveLength(2);
		expect(out!.messages[0].content).toContain("DIGEST TEXT");
		expect(out!.messages[1].content).toBe("next ask");

		// later LLM calls in the same turn reuse the digest — no re-summarise
		const again = await state.transformContext([...msgs, { role: "assistant", content: "working" }]);
		expect(digestCalls).toBe(1);
		expect(again?.messages[0].content).toContain("DIGEST TEXT");
	});

	test("history below minChars clears the one-shot flag", async () => {
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, minChars: 10000 } } });
		let calls = 0;
		(state as any).summarize = async () => {
			calls++;
			return "x";
		};
		(state as any).digestPending = true;
		expect(await state.transformContext([...history(1, 10), { role: "user", content: "ask" }])).toBeUndefined();
		expect(calls).toBe(0);
		expect((state as any).digestPending).toBe(false);
	});

	test("history not covered by the digest stays in the request", async () => {
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, minChars: 50 } } });
		(state as any).summarize = async () => "D";
		(state as any).digest = "D";
		(state as any).digestCovered = 2; // digest covers only first history msg
		const msgs = [...history(3, 100), { role: "user", content: "ask" }];
		const out = await state.transformContext(msgs);
		// digest + 4 uncovered history msgs + current ask
		expect(out!.messages[0].content).toContain("[laya-router conversation digest]");
		expect(out!.messages.length).toBe(6);
		expect(out!.messages[out!.messages.length - 1].content).toBe("ask");
	});

	test("input cap digests only the oldest prefix and keeps the rest verbatim", async () => {
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, minChars: 50, maxInputChars: 250 } } });
		const prompts: string[] = [];
		(state as any).summarize = async (p: string) => {
			prompts.push(p);
			return "D";
		};
		(state as any).digestPending = true;
		const msgs = [...history(3, 100), { role: "user", content: "ask" }];
		const out = await state.transformContext(msgs);
		// 250-char budget fits only the two oldest history messages
		expect((state as any).digestCovered).toBe(2);
		// digest + 4 uncovered history msgs + current ask — nothing dropped
		expect(out!.messages).toHaveLength(6);
		expect(out!.messages[5].content).toBe("ask");
	});

	test("orphan tool results at the coverage boundary get folded into coverage, not left stranded", async () => {
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, minChars: 50 } } });
		(state as any).summarize = async () => "D";
		(state as any).digest = "D";
		(state as any).digestPending = true; // forces a refresh even with few uncovered turns
		const msgs = [
			{ role: "user", content: "q with " + "u".repeat(100) },
			{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "1", toolName: "read", content: "output " + "o".repeat(100) },
			{ role: "user", content: "ask" },
		];
		const out = await state.transformContext(msgs);
		// coverage advanced past the orphaned toolResult (index 2) — it must not
		// sit in the uncovered slice without its tool-call message
		expect((state as any).digestCovered).toBeGreaterThan(2);
		expect(out!.messages.some((m: any) => m.role === "toolResult")).toBe(false);
	});

	test("resetDigest drops stale coverage after pi rebuilds the transcript", async () => {
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, minChars: 50 } } });
		(state as any).summarize = async () => "D";
		(state as any).digest = "D";
		(state as any).digestCovered = 99; // stale index from a pre-compaction transcript
		state.resetDigest();
		expect((state as any).digest).toBeUndefined();
		expect((state as any).digestCovered).toBe(0);
		// with no digest the handler passes the (compacted) transcript through untouched
		expect(await state.transformContext([...history(1, 100), { role: "user", content: "ask" }])).toBeUndefined();
	});

	test("summariser failures stop after 2 and never drop the current turn", async () => {
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, minChars: 50 } } });
		let calls = 0;
		(state as any).summarize = async () => {
			calls++;
			throw new Error("model down");
		};
		(state as any).digestPending = true;
		const msgs = [...history(3, 100), { role: "user", content: "ask" }];
		expect(await state.transformContext(msgs)).toBeUndefined();
		expect(await state.transformContext(msgs)).toBeUndefined();
		expect(calls).toBe(2);
		// capped: third call must not invoke the summariser at all
		expect(await state.transformContext(msgs)).toBeUndefined();
		expect(calls).toBe(2);
	});

	test("refresh after refreshTurns uncovered user messages", async () => {
		const state = stateWith({ ...CFG, routing: { summarizer: { enabled: true, minChars: 50, refreshTurns: 2 } } });
		let calls = 0;
		(state as any).summarize = async () => {
			calls++;
			return `D${calls}`;
		};
		(state as any).digest = "D0";
		const msgs = [...history(5, 100), { role: "user", content: "extra1" }, { role: "assistant", content: "a1" }, { role: "user", content: "extra2" }, { role: "assistant", content: "a2" }, { role: "user", content: "ask" }];
		(state as any).digestCovered = 10; // original digest covered the first 5 pairs
		const out = await state.transformContext(msgs);
		expect(calls).toBe(1);
		expect(out!.messages[0].content).toContain("D1");
		// refresh only absorbs what it actually digested — coverage stays a prefix count
		expect((state as any).digestCovered).toBe(14);
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
