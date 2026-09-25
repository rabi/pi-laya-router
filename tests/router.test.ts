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
		new Response(JSON.stringify({ answers: { route: { choice, confidence } } }), { status: 200 })) as typeof fetch;
	return () => (globalThis.fetch = original);
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
		expect(d?.bucket).toBe("code");
		expect(setModel).toHaveBeenCalledTimes(1);
		expect((setModel.mock.calls[0][0] as Model<any>).id).toBe("opus");
		expect(setThinking.mock.calls[0][0]).toBe("high");
		expect(state.lastDecision).toContain("code (0.90) -> anthropic/opus");
		restore();
	});

	test("no switch when already on target model", async () => {
		const restore = stubAnswer("code", 0.9);
		const state = new RouterState();
		state.cfg = structuredClone(CFG);
		const { ctx } = mockCtx({ id: "opus", provider: "anthropic" } as Model<any>);
		const setModel = mock(async () => true);

		expect(await state.route(ctx, "x", setModel, mock(() => {}), getThinking("off"))).toBeUndefined();
		expect(setModel).not.toHaveBeenCalled();
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
