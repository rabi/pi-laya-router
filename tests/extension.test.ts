import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ext from "../extensions/laya-router.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROUTER_JSON = {
	serveUrl: "http://test:8000",
	minConfidence: 0.5,
	defaultRoute: "quick",
	routing: { summarizer: { enabled: true, provider: "openai", model: "mini", minChars: 50 } },
	routes: {
		quick: { provider: "openai", model: "mini", description: "simple" },
		code: { provider: "anthropic", model: "opus", description: "coding", thinkingLevel: "high" },
	},
};

const saved = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (saved !== undefined) process.env.PI_CODING_AGENT_DIR = saved;
	else delete process.env.PI_CODING_AGENT_DIR;
});

const originalFetch = globalThis.fetch;

function fakePi() {
	const handlers = new Map<string, Function[]>();
	const api = {
		registerTool: mock(() => {}),
		registerCommand: mock(() => {}),
		on: mock((event: string, handler: Function) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
			return () => {};
		}),
		setModel: mock(async () => true),
		setThinkingLevel: mock(() => {}),
		getThinkingLevel: () => "off" as const,
	} as unknown as ExtensionAPI & Record<string, any>;
	const fire = async (event: string, ev: any, ctx: any) => {
		for (const h of handlers.get(event) ?? []) {
			const r = await h(ev, ctx);
			if (r !== undefined) return r;
		}
		return undefined;
	};
	return { api, handlers, fire };
}

function fakeCtx(model?: any) {
	const compactCalls: any[] = [];
	return {
		cwd: "/nonexistent-cwd-for-test",
		model: model ?? { id: "mini", provider: "openai" },
		signal: undefined,
		ui: { notify: mock(() => {}) },
		modelRegistry: {
			find: (provider: string, id: string) => ({ id, provider }),
			hasConfiguredAuth: () => true,
			complete: mock(async () => ({ content: [{ type: "text", text: "SUMMARY" }], stopReason: "stop", usage: { totalTokens: 10 } })),
		},
		getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }),
		compact: (opts?: any) => { compactCalls.push(opts); },
		compactCalls,
	};
}

function agentDirWith(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "ext-agent-"));
	writeFileSync(join(dir, "router.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

describe("extension wiring", () => {
	test("registers 5 tools, the command, and event handlers", () => {
		const { api, handlers } = fakePi();
		ext(api);
		expect(api.registerTool.mock.calls.length).toBe(5);
		expect(api.registerCommand.mock.calls[0][0]).toBe("laya-router");
		for (const ev of ["session_start", "before_agent_start", "session_before_compact", "session_compact"]) {
			expect(handlers.has(ev)).toBe(true);
		}
	});

	test("prompt routes through setModel/setThinkingLevel after session_start loads config", async () => {
		agentDirWith(ROUTER_JSON);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ answers: { route: { choice: "code", answer_confidence: 0.9 } } }), {
				status: 200,
			})) as typeof fetch;
		const { api, fire } = fakePi();
		ext(api);
		const ctx = fakeCtx();
		await fire("session_start", {}, ctx);
		await fire("before_agent_start", { prompt: "implement auth" }, ctx);
		expect(api.setModel).toHaveBeenCalledTimes(1);
		expect(api.setThinkingLevel).toHaveBeenCalledWith("high");
	});

	test("model switch triggers ctx.compact", async () => {
		agentDirWith(ROUTER_JSON);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ answers: { route: { choice: "code", answer_confidence: 0.9 } } }), {
				status: 200,
			})) as typeof fetch;
		const { fire } = fakePi();
		ext(fakePi().api);
		const { api: api2, fire: fire2 } = fakePi();
		ext(api2);
		const ctx = fakeCtx();
		await fire2("session_start", {}, ctx);
		await fire2("before_agent_start", { prompt: "implement auth" }, ctx);
		expect(ctx.compactCalls).toHaveLength(1);
		expect(ctx.compactCalls[0].customInstructions).toContain("Model switch");
	});

	test("no config anywhere: before_agent_start is a silent no-op", async () => {
		process.env.PI_CODING_AGENT_DIR = "/nonexistent-agent-dir";
		const { api, fire } = fakePi();
		ext(api);
		const ctx = fakeCtx();
		await fire("session_start", {}, ctx);
		await fire("before_agent_start", { prompt: "hi" }, ctx);
		expect(api.setModel).not.toHaveBeenCalled();
	});

	test("session_before_compact uses cheap model when compactingForSwitch", async () => {
		agentDirWith(ROUTER_JSON);
		const { fire } = fakePi();
		ext(fakePi().api);
		const { api: api2, fire: fire2 } = fakePi();
		ext(api2);
		const ctx = fakeCtx();
		await fire2("session_start", {}, ctx);

		// Simulate: model switch happened, compactingForSwitch is set
		// (normally set by route() calling ctx.compact)
		const handlers = (fire2 as any);
		// Access the state through the handler side-effect: fire before_agent_start with a switch
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ answers: { route: { choice: "code", answer_confidence: 0.9 } } }), {
				status: 200,
			})) as typeof fetch;
		await fire2("before_agent_start", { prompt: "implement auth" }, ctx);

		// Now fire session_before_compact
		const event = {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "entry-1",
				messagesToSummarize: [{ role: "user" as const, content: "old question" }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 5000,
				previousSummary: undefined,
				fileOps: { readFiles: [], modifiedFiles: [] },
				settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			},
			branchEntries: [],
			reason: "manual" as const,
			willRetry: false,
			signal: new AbortController().signal,
		};
		const result = await fire2("session_before_compact", event, ctx);
		expect(result).toBeDefined();
		expect(result!.compaction).toBeDefined();
		expect(result!.compaction!.firstKeptEntryId).toBe("entry-1");
		expect(result!.compaction!.tokensBefore).toBe(5000);
	});

	test("session_before_compact passes through when not compactingForSwitch", async () => {
		agentDirWith(ROUTER_JSON);
		const { api, fire } = fakePi();
		ext(api);
		const ctx = fakeCtx();
		await fire("session_start", {}, ctx);

		// No model switch happened, so compactingForSwitch is false
		const event = {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "entry-1",
				messagesToSummarize: [{ role: "user" as const, content: "old" }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1000,
				previousSummary: undefined,
				fileOps: { readFiles: [], modifiedFiles: [] },
				settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			},
			branchEntries: [],
			reason: "threshold" as const,
			willRetry: false,
			signal: new AbortController().signal,
		};
		const result = await fire("session_before_compact", event, ctx);
		expect(result).toBeUndefined();
	});

	test("session_compact resets compactingForSwitch", async () => {
		agentDirWith(ROUTER_JSON);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ answers: { route: { choice: "code", answer_confidence: 0.9 } } }), {
				status: 200,
			})) as typeof fetch;
		const { api, fire } = fakePi();
		ext(api);
		const ctx = fakeCtx();
		await fire("session_start", {}, ctx);
		await fire("before_agent_start", { prompt: "implement auth" }, ctx);

		// compact was triggered, flag is set. Now session_compact fires → resets.
		await fire("session_compact", { compactionEntry: {} }, ctx);

		// Subsequent session_before_compact should pass through (no cheap model intercept)
		const event = {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "e1",
				messagesToSummarize: [{ role: "user" as const, content: "x" }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { readFiles: [], modifiedFiles: [] },
				settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			},
			branchEntries: [],
			reason: "threshold" as const,
			willRetry: false,
			signal: new AbortController().signal,
		};
		const result = await fire("session_before_compact", event, ctx);
		expect(result).toBeUndefined();
	});
});
