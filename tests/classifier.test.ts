import { afterEach, describe, expect, mock, test } from "bun:test";
import { classify, classifyState, routeCriteria } from "../extensions/laya-router/classifier.ts";
import { LayaError } from "../extensions/laya-router/client.ts";
import type { RouterConfig } from "../extensions/laya-router/types.ts";

const CFG: RouterConfig = {
	serveUrl: "http://test:8000",
	minConfidence: 0.5,
	defaultRoute: "quick",
	routes: {
		quick: { provider: "openai", model: "mini", description: "simple" },
		code: { provider: "openai", model: "big", description: "coding" },
	},
};

const originalFetch = globalThis.fetch;

function stubFetch(handler: (body: unknown, headers: Headers) => Response | Promise<Response>) {
	const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		const headers = new Headers(init?.headers as Record<string, string>);
		calls.push({ url: String(url), body, headers: Object.fromEntries(headers.entries()) });
		return handler(body, headers);
	}) as typeof fetch;
	return calls;
}

function answer(choice: string, confidence: number): Response {
	return new Response(JSON.stringify({ answers: { route: { choice, confidence } } }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("routeCriteria", () => {
	test("maps route names to descriptions", () => {
		expect(routeCriteria(CFG)).toEqual({ quick: "simple", code: "coding" });
	});
});

describe("classify", () => {
	test("returns the chosen route when confidence passes", async () => {
		const calls = stubFetch(() => answer("code", 0.9));
		const d = await classify(CFG, "write a parser");
		expect(d).toEqual({ bucket: "code", confidence: 0.9, gated: false, route: CFG.routes.code });
		expect(calls[0].url).toBe("http://test:8000/v1/systemone");
		const sent = calls[0].body as { questions: { route: { criteria: Record<string, string> } } };
		expect(sent.questions.route.criteria).toEqual({ quick: "simple", code: "coding" });
	});

	test("sends API key as bearer token", async () => {
		const calls = stubFetch(() => answer("quick", 0.9));
		await classify({ ...CFG, apiKey: "sk-1" }, "hi");
		expect(calls[0].headers["authorization"]).toBe("Bearer sk-1");
	});

	test("low confidence gates to defaultRoute", async () => {
		stubFetch(() => answer("code", 0.2));
		const d = await classify(CFG, "hi");
		expect(d?.bucket).toBe("quick");
		expect(d?.gated).toBe(true);
	});

	test("hallucinated bucket gates to defaultRoute", async () => {
		stubFetch(() => answer("quantum-physics", 0.99));
		const d = await classify(CFG, "hi");
		expect(d?.bucket).toBe("quick");
		expect(d?.gated).toBe(true);
	});

	test("unknown bucket without defaultRoute returns undefined", async () => {
		stubFetch(() => answer("nonsense", 0.99));
		const cfg = { ...structuredClone(CFG), defaultRoute: undefined };
		expect(await classify(cfg, "hi")).toBeUndefined();
	});

	test("missing choice returns undefined", async () => {
		stubFetch(() => new Response(JSON.stringify({ answers: {} }), { status: 200 }));
		expect(await classify(CFG, "hi")).toBeUndefined();
	});

	test("missing confidence defaults to 0 (gated)", async () => {
		stubFetch(() => new Response(JSON.stringify({ answers: { route: { choice: "code" } } }), { status: 200 }));
		const d = await classify(CFG, "hi");
		expect(d?.gated).toBe(true);
		expect(d?.bucket).toBe("quick");
	});

	test("long prose prompt truncated to maxPromptChars", async () => {
		const calls = stubFetch(() => answer("quick", 0.9));
		await classify({ ...CFG, routing: { maxPromptChars: 10 } }, "a".repeat(50));
		expect((calls[0].body as { state: string }).state).toHaveLength(10);
	});

	test("non-200 becomes LayaError with status and body", async () => {
		stubFetch(() => new Response("gpu on fire", { status: 503 }));
		expect(classify(CFG, "hi")).rejects.toThrow(LayaError);
		expect(classify(CFG, "hi")).rejects.toThrow(/503.*gpu on fire/);
	});

	test("non-JSON body becomes LayaError", async () => {
		stubFetch(() => new Response("<html>nope</html>", { status: 200 }));
		expect(classify(CFG, "hi")).rejects.toThrow(/non-JSON/);
	});

	test("network failure becomes LayaError", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		expect(classify(CFG, "hi")).rejects.toThrow(/unreachable/);
	});
});

describe("classifyState", () => {
	test("short prompt passes through", () => {
		expect(classifyState("hello there", 100)).toBe("hello there");
	});

	test("code lines and fences stripped, prose kept", () => {
		const prompt = [
			"please review this for bugs",
			"```js",
			"function f(x) { if (x > 0) { return x; } }",
			"function g(x) { if (x < 0) { return -x; } }",
			"for (const i of items) { total += i; }",
			"```",
		].join("\n");
		expect(classifyState(prompt, 3000)).toBe("please review this for bugs");
	});

	test("prose capped by limit", () => {
		const state = classifyState("word ".repeat(100), 10);
		expect(state).toHaveLength(10);
	});

	test("all-code prompt falls back to tail slice", () => {
		const code = "function f(x) { return x; }\n".repeat(60);
		const state = classifyState(code, 60);
		expect(state).toBe(code.slice(-60));
	});

	test("short prose kept, code payload dropped", () => {
		const code = "let a = 1; const b = a + 2;\n".repeat(50) + "short ask";
		expect(classifyState(code, 40)).toBe("short ask");
	});

	test("long prose keeps the tail where the request lives", () => {
		const prose = "background detail. ".repeat(100) + "please review this";
		const state = classifyState(prose, 30);
		expect(state).toHaveLength(30);
		expect(state).toEndWith("review this");
	});
});
