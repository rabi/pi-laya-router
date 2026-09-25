import { describe, expect, mock, test } from "bun:test";
import { digestMergePrompt, digestPrompt, makeSummarizer, transcriptTurns } from "../extensions/laya-router/summarizer.ts";
import type { Model } from "@earendil-works/pi-ai";

const MODEL = { id: "mini", provider: "openai" } as Model<any>;

describe("transcriptTurns", () => {
	test("keeps tool calls and truncates tool results — nothing the model saw is dropped", () => {
		const msgs = [
			{ role: "user", content: "fix the bug" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading" },
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } },
				],
			},
			{ role: "toolResult", toolCallId: "1", toolName: "read", content: "z".repeat(3000) },
			{ role: "assistant", content: "done" },
		];
		const turns = transcriptTurns(msgs);
		expect(turns.map((t) => t.label)).toEqual(["USER", "ASSISTANT", "TOOL RESULT", "ASSISTANT"]);
		expect(turns[1].text).toContain("[tool call] read");
		expect(turns[2].text).toContain("chars truncated");
		expect(turns[2].text.length).toBeLessThan(2100);
		expect(turns.map((t) => t.msgIndex)).toEqual([0, 1, 2, 3]);
	});
});

describe("digestPrompt", () => {
	test("digests the oldest prefix that fits; covered reports how far it got", () => {
		const turns = transcriptTurns([
			{ role: "user", content: "u".repeat(100) },
			{ role: "assistant", content: "a".repeat(100) },
			{ role: "user", content: "u".repeat(100) },
		]);
		const req = digestPrompt(turns, 250)!;
		expect(req.covered).toBe(2); // only first two turns fit
		expect(req.prompt).toContain("USER:");
	});

	test("cap smaller than one turn still digests the first turn (coverage progresses)", () => {
		const turns = transcriptTurns([{ role: "user", content: "u".repeat(100) }, { role: "user", content: "second" }]);
		const req = digestPrompt(turns, 10)!;
		expect(req.covered).toBe(1);
	});

	test("empty turns produce no request", () => {
		expect(digestPrompt([], 1000)).toBeUndefined();
	});

	test("merge prompt keeps previous digest and relative coverage", () => {
		const turns = transcriptTurns([{ role: "user", content: "new stuff" }]);
		const req = digestMergePrompt("OLD DIGEST", turns, 5000)!;
		expect(req.prompt).toContain("OLD DIGEST");
		expect(req.covered).toBe(1);
	});
});

describe("makeSummarizer", () => {
	const cfg = { enabled: true, provider: "openai", model: "mini" };

	test("routes the completion through the injected (Pi-authenticated) complete fn", async () => {
		const complete = mock(async () => ({ content: [{ type: "text", text: " summary " }], stopReason: "stop" }));
		const fn = makeSummarizer(cfg, () => MODEL, () => true, complete)!;
		const controller = new AbortController();
		expect(await fn("instr", controller.signal)).toBe("summary");
		expect(complete).toHaveBeenCalledTimes(1);
		const [model, context, options] = complete.mock.calls[0];
		expect(model).toBe(MODEL);
		expect(context.messages[0].content).toBe("instr");
		expect(options.signal).toBe(controller.signal);
		expect(options.cacheRetention).toBe("none");
	});

	test("error stopReason and empty output both throw", async () => {
		const fnErr = makeSummarizer(cfg, () => MODEL, () => true, async () => ({ content: [], stopReason: "error", errorMessage: "boom" }))!;
		expect(fnErr).toBeDefined();
		await expect(fnErr("x")).rejects.toThrow("boom");

		const fnEmpty = makeSummarizer(cfg, () => MODEL, () => true, async () => ({ content: [] }))!;
		await expect(fnEmpty("x")).rejects.toThrow("empty digest");
	});

	test("disabled config or unauthenticated model yields undefined", () => {
		expect(makeSummarizer(undefined, () => MODEL, () => true, async () => ({ content: [] }))).toBeUndefined();
		expect(makeSummarizer({ ...cfg, enabled: false }, () => MODEL, () => true, async () => ({ content: [] }))).toBeUndefined();
		expect(makeSummarizer(cfg, () => MODEL, () => false, async () => ({ content: [] }))).toBeUndefined();
		expect(makeSummarizer(cfg, () => undefined, () => true, async () => ({ content: [] }))).toBeUndefined();
	});
});
