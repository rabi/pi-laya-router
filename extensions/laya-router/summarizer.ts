import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { DEFAULTS, type SummarizerConfig } from "./types.ts";

const SYSTEM_PROMPT =
	"You compress coding-agent conversation transcripts. Write a dense handover digest " +
	"so a different model can continue the work without re-reading the transcript. " +
	"Cover: the user's goal, decisions made and why, current state of the work " +
	"(files, edits, results), open questions and next steps, constraints the user stated. " +
	"Prefer bullets. Never pad, never restate the obvious.";

export interface DigestInput {
	role: string;
	text: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
			.join("\n");
	}
	return "";
}

/** Flatten transcript to role/text turns, dropping tool calls/results (noise for a handover). */
export function transcriptTurns(messages: readonly any[]): DigestInput[] {
	const turns: DigestInput[] = [];
	for (const m of messages ?? []) {
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = textOf(m.content).trim();
		if (!text) continue;
		turns.push({ role: m.role, text });
	}
	return turns;
}

export function transcriptChars(turns: readonly DigestInput[]): number {
	return turns.reduce((n, t) => n + t.text.length, 0);
}

/** Build the summariser request; exports the prompt so it stays testable. */
export function digestPrompt(turns: readonly DigestInput[], maxInputChars: number): string {
	const cap = maxInputChars ?? DEFAULTS.summaryMaxInputChars;
	let kept: DigestInput[] = [];
	let total = 0;
	// newest turns matter most — walk backwards until the cap bites
	for (let i = turns.length - 1; i >= 0; i--) {
		total += turns[i].text.length;
		if (total > cap) break;
		kept.unshift(turns[i]);
	}
	if (kept.length === 0 && turns.length > 0) kept = [turns[turns.length - 1]];
	const body = kept.map((t) => `${t.role.toUpperCase()}: ${t.text}`).join("\n\n");
	return `${SYSTEM_PROMPT}\n\n--- TRANSCRIPT ---\n${body}`;
}

/** Refresh: fold the previous digest plus newer turns into one updated digest. */
export function digestMergePrompt(
	previousDigest: string,
	turns: readonly DigestInput[],
	maxInputChars: number,
): string {
	const room = Math.max(1000, maxInputChars - previousDigest.length);
	return `${digestPrompt(turns, room)}\n\n--- PREVIOUS DIGEST (merge in anything not yet reflected) ---\n${previousDigest}`;
}

export type SummarizeFn = (instructions: string, signal?: AbortSignal) => Promise<string>;

/**
 * Build a summarize fn bound to a concrete model, or undefined when the
 * summariser is disabled / its model cannot be resolved. Errors from the
 * completion are swallowed by the caller (RouterState) — digest is best-effort.
 */
export function makeSummarizer(
	cfg: SummarizerConfig | undefined,
	findModel: (provider: string, modelId: string) => Model<any> | undefined,
	hasAuth: (model: Model<any>) => boolean,
): SummarizeFn | undefined {
	if (!cfg || cfg.enabled === false || !cfg.provider || !cfg.model) return undefined;
	const model = findModel(cfg.provider, cfg.model);
	if (!model || !hasAuth(model)) return undefined;
	const maxTokens = cfg.maxTokens ?? DEFAULTS.summaryMaxTokens;
	const timeoutMs = cfg.timeoutMs ?? DEFAULTS.summaryTimeoutMs;
	const level = cfg.thinkingLevel;
	return async (instructions: string, signal?: AbortSignal) => {
		const params: any = { maxTokens, timeoutMs, cacheRetention: "none" };
		if (level) params.reasoning = level;
		const msg = await completeSimple(model, { messages: [{ role: "user", content: instructions }] }, params);
		if (msg.stopReason === "error") throw new Error(msg.errorMessage || "summariser call failed");
		return textOf(msg.content).trim();
	};
}
