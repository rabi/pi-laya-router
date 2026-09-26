import type { Model } from "@earendil-works/pi-ai";
import { DEFAULTS, type SummarizerConfig } from "./types.ts";

const SYSTEM_PROMPT =
	"You compress coding-agent conversation transcripts. Write a dense handover digest " +
	"so a different model can continue the work without re-reading the transcript. " +
	"Cover: the user's goal, decisions made and why, current state of the work " +
	"(files, edits, results), open questions and next steps, constraints the user stated. " +
	"Prefer bullets. Never pad, never restate the obvious.";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
			.join("\n");
	}
	return "";
}

export type SummarizeFn = (transcript: string, previousSummary?: string, signal?: AbortSignal) => Promise<{ summary: string; usage?: any }>;

export type CompleteFn = (
	model: Model<any>,
	context: { messages: any[] },
	options: any,
) => Promise<{ content: unknown; stopReason?: string; errorMessage?: string; usage?: any }>;

export function makeSummarizer(
	cfg: SummarizerConfig | undefined,
	findModel: (provider: string, modelId: string) => Model<any> | undefined,
	hasAuth: (model: Model<any>) => boolean,
	complete: CompleteFn,
): SummarizeFn | undefined {
	if (!cfg || cfg.enabled === false || !cfg.provider || !cfg.model) return undefined;
	const model = findModel(cfg.provider, cfg.model);
	if (!model || !hasAuth(model)) return undefined;
	const maxTokens = cfg.maxTokens ?? DEFAULTS.summaryMaxTokens;
	const maxInputChars = cfg.maxInputChars ?? DEFAULTS.summaryMaxInputChars;
	const timeoutMs = cfg.timeoutMs ?? DEFAULTS.summaryTimeoutMs;
	const level = cfg.thinkingLevel;
	return async (transcript: string, previousSummary, signal) => {
		if (transcript.length > maxInputChars) transcript = "[…older transcript truncated]\n" + transcript.slice(-maxInputChars);
		const parts = [SYSTEM_PROMPT, `\n--- TRANSCRIPT ---\n${transcript}`];
		if (previousSummary) parts.push(`\n--- PREVIOUS DIGEST (merge in anything not yet reflected) ---\n${previousSummary}`);
		const params: any = { maxTokens, timeoutMs, cacheRetention: "none" };
		if (level) params.reasoning = level;
		if (signal) params.signal = signal;
		const msg = await complete(model, { messages: [{ role: "user", content: parts.join("") }] }, params);
		if (msg.stopReason === "error") throw new Error(msg.errorMessage || "summariser call failed");
		const text = textOf(msg.content).trim();
		if (!text) {
			// A thinking model that burns its token budget on reasoning produces
			// thinking blocks but no text block — the digest silently vanishes.
			if (msg.stopReason === "length") {
				throw new Error(`summariser hit its ${maxTokens}-token budget before producing a digest (likely thinking overhead — set thinkingLevel "off" or raise maxTokens)`);
			}
			throw new Error(`summariser returned empty digest (stopReason: ${msg.stopReason ?? "unknown"})`);
		}
		return { summary: text, usage: msg.usage };
	};
}
