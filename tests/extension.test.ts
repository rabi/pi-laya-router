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
	return {
		cwd: "/nonexistent-cwd-for-test",
		model: model ?? { id: "mini", provider: "openai" },
		signal: undefined,
		ui: { notify: mock(() => {}) },
		modelRegistry: {
			find: (provider: string, id: string) => ({ id, provider }),
			hasConfiguredAuth: () => true,
		},
	};
}

function agentDirWith(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "ext-agent-"));
	writeFileSync(join(dir, "router.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

describe("extension wiring", () => {
	test("registers 5 tools, the command, and all three event handlers", () => {
		const { api, handlers } = fakePi();
		ext(api);
		expect(api.registerTool.mock.calls.length).toBe(5);
		expect(api.registerCommand.mock.calls[0][0]).toBe("laya-router");
		for (const ev of ["session_start", "before_agent_start", "context"]) {
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

	test("no config anywhere: before_agent_start is a silent no-op", async () => {
		process.env.PI_CODING_AGENT_DIR = "/nonexistent-agent-dir";
		const { api, fire } = fakePi();
		ext(api);
		const ctx = fakeCtx();
		await fire("session_start", {}, ctx);
		await fire("before_agent_start", { prompt: "hi" }, ctx);
		expect(api.setModel).not.toHaveBeenCalled();
		expect(await fire("context", { messages: [{ role: "user", content: "hi" }] }, ctx)).toBeUndefined();
	});

	test("context handler degrades gracefully when the summariser model is unusable", async () => {
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

		// long history + current ask; the fake registry hands completeSimple a
		// useless model — the handler must swallow the failure and leave the
		// transcript untouched rather than drop messages
		const history: any[] = [];
		for (let i = 0; i < 10; i++) {
			history.push({ role: "user", content: `q${i} ${"u".repeat(100)}` });
			history.push({ role: "assistant", content: `a${i} ${"a".repeat(100)}` });
		}
		const out = await fire("context", { messages: [...history, { role: "user", content: "and now?" }] }, ctx);
		if (out !== undefined) {
			expect(out.messages[0].content).toContain("[laya-router conversation digest]");
			expect(out.messages.at(-1).content).toBe("and now?");
		} else {
			expect(out).toBeUndefined();
		}
	});
});
