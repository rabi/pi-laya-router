import { describe, expect, mock, test } from "bun:test";
import { makeSummarizer } from "../extensions/laya-router/summarizer.ts";

describe("makeSummarizer", () => {
	test("returns undefined when config is missing", () => {
		expect(makeSummarizer(undefined, () => undefined, () => true, () => Promise.resolve({ content: "", stopReason: "stop" } as any))).toBeUndefined();
	});

	test("returns undefined when enabled=false", () => {
		expect(makeSummarizer({ enabled: false, provider: "p", model: "m" }, () => undefined, () => true, () => Promise.resolve({ content: "", stopReason: "stop" } as any))).toBeUndefined();
	});

	test("returns undefined when model not found", () => {
		expect(makeSummarizer(
			{ enabled: true, provider: "p", model: "m" },
			() => undefined,
			() => true,
			() => Promise.resolve({ content: "", stopReason: "stop" } as any),
		)).toBeUndefined();
	});

	test("returns undefined when no auth", () => {
		expect(makeSummarizer(
			{ enabled: true, provider: "p", model: "m" },
			() => ({ id: "m", provider: "p" }) as any,
			() => false,
			() => Promise.resolve({ content: "", stopReason: "stop" } as any),
		)).toBeUndefined();
	});

	test("returns a summarize fn that calls the model with transcript + prompt", async () => {
		let captured: any;
		const complete = mock(async (model: any, context: any, options: any) => {
			captured = { model, context, options };
			return { content: [{ type: "text", text: "SUMMARY TEXT" }], stopReason: "stop", usage: { totalTokens: 42 } };
		});
		const fn = makeSummarizer(
			{ enabled: true, provider: "p", model: "cheap", maxTokens: 512 },
			(p, m) => (p === "p" && m === "cheap" ? { id: m, provider: p } : undefined) as any,
			() => true,
			complete as any,
		);
		expect(fn).toBeDefined();

		const result = await fn!("CONVERSATION TEXT", undefined, undefined);
		expect(result.summary).toBe("SUMMARY TEXT");
		expect(result.usage).toEqual({ totalTokens: 42 });

		// verify the prompt contains both system prompt and transcript
		const userMsg = captured.context.messages[0];
		expect(userMsg.role).toBe("user");
		expect(userMsg.content).toContain("CONVERSATION TEXT");
		expect(userMsg.content).toContain("compress coding-agent conversation transcripts");

		// verify options
		expect(captured.options.maxTokens).toBe(512);
		expect(captured.options.cacheRetention).toBe("none");
	});

	test("includes previous summary when provided", async () => {
		let content: string;
		const complete = mock(async (_m: any, ctx: any) => {
			content = ctx.messages[0].content;
			return { content: [{ type: "text", text: "MERGED" }], stopReason: "stop" };
		});
		const fn = makeSummarizer(
			{ enabled: true, provider: "p", model: "cheap" },
			() => ({ id: "m", provider: "p" }) as any,
			() => true,
			complete as any,
		);
		await fn!("NEW TRANSCRIPT", "OLD DIGEST", undefined);
		expect(content).toContain("OLD DIGEST");
		expect(content).toContain("NEW TRANSCRIPT");
		expect(content).toContain("PREVIOUS DIGEST");
	});

	test("throws when model returns error stop reason", async () => {
		const complete = mock(async () => ({ content: "", stopReason: "error", errorMessage: "rate limited" }));
		const fn = makeSummarizer(
			{ enabled: true, provider: "p", model: "m" },
			() => ({ id: "m", provider: "p" }) as any,
			() => true,
			complete as any,
		);
		await expect(fn!("text")).rejects.toThrow("rate limited");
	});

	test("throws when model returns empty content", async () => {
		const complete = mock(async () => ({ content: "", stopReason: "stop" }));
		const fn = makeSummarizer(
			{ enabled: true, provider: "p", model: "m" },
			() => ({ id: "m", provider: "p" }) as any,
			() => true,
			complete as any,
		);
		await expect(fn!("text")).rejects.toThrow("empty digest (stopReason: stop)");
	});

	test("diagnoses token-budget exhaustion when thinking consumed the output", async () => {
		const complete = mock(async () => ({ content: [{ type: "thinking", thinking: "..." }], stopReason: "length" }));
		const fn = makeSummarizer(
			{ enabled: true, provider: "p", model: "m", maxTokens: 1024 },
			() => ({ id: "m", provider: "p" }) as any,
			() => true,
			complete as any,
		);
		await expect(fn!("text")).rejects.toThrow("1024-token budget");
	});
});
