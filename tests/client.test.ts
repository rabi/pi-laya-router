import { afterEach, describe, expect, test } from "bun:test";
import { compact, layaAsk, layaHealth, LayaError } from "../extensions/laya-router/client.ts";
import type { RouterConfig } from "../extensions/laya-router/types.ts";

const CFG: RouterConfig = {
	serveUrl: "http://test:8000",
	routes: { a: { provider: "p", model: "m", description: "d" } },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("layaHealth", () => {
	test("returns status and body", async () => {
		globalThis.fetch = (async (url: RequestInfo | URL) => {
			expect(String(url)).toBe("http://test:8000/health");
			return new Response("ok: gpu A100", { status: 200 });
		}) as typeof fetch;
		expect(await layaHealth(CFG)).toBe("200: ok: gpu A100");
	});

	test("reports non-200 without throwing", async () => {
		globalThis.fetch = (async () => new Response("degraded", { status: 503 })) as typeof fetch;
		expect(await layaHealth(CFG)).toBe("503: degraded");
	});

	test("network failure becomes LayaError", async () => {
		globalThis.fetch = (async () => {
			throw new TypeError("connection refused");
		}) as typeof fetch;
		expect(layaHealth(CFG)).rejects.toThrow(LayaError);
		expect(layaHealth(CFG)).rejects.toThrow(/unreachable.*connection refused/);
	});

	test("external abort propagates as AbortError, not LayaError", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
			const e = new Error("aborted");
			e.name = "AbortError";
			throw e;
		}) as typeof fetch;
		expect(layaHealth(CFG, ctrl.signal)).rejects.toThrow(/\baborted\b/);
		expect(layaHealth(CFG, ctrl.signal)).rejects.not.toThrow(LayaError);
	});

	test("timeout (no external signal) reports timed out, not unreachable", async () => {
		globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
			const signal = (init?.signal ?? null) as AbortSignal | null;
			return await new Promise<Response>((_, reject) => {
				signal?.addEventListener("abort", () => {
					const e = new Error("The operation was aborted due to timeout");
					e.name = "TimeoutError";
					reject(e);
				});
			});
		}) as typeof fetch;
		expect(layaAsk({ ...CFG, timeoutMs: 1 }, { state: "s", questions: {} })).rejects.toThrow(/timed out after 1ms/);
	});
});

describe("compact", () => {
	test("pretty-prints small values", () => {
		expect(compact({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	test("truncates oversized output", () => {
		const out = compact({ big: "x".repeat(5000) }, 100);
		expect(out.length).toBeLessThanOrEqual(100 + "\n... truncated ...".length);
		expect(out).toEndWith("... truncated ...");
	});

	test("handles circular structures without throwing", () => {
		const circ: Record<string, unknown> = {};
		circ.self = circ;
		expect(typeof compact(circ)).toBe("string");
	});
});
