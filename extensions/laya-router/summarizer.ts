import type { Model } from "@earendil-works/pi-ai";
import { DEFAULTS, type SummarizerConfig } from "./types.ts";

const SYSTEM_PROMPT =
	"You compress coding-agent conversation transcripts. Write a dense handover digest " +
	"so a different model can continue the work without re-reading the transcript. " +
	"Cover: the user's goal, decisions made and why, current state of the work " +
	"(files, edits, results), open questions and next steps, constraints the user stated. " +
	"Prefer bullets. Never pad, never restate the obvious.";

export interface DigestInput {
	/** index within the message list passed to transcriptTurns */
	msgIndex: number;
	label: string;
	text: string;
}

const TOOL_RESULT_CHARS = 2000;
const TOOL_CALL_CHARS = 200;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
			.join("\n");
	}
	return "";
}

function messageText(m: any): string {
	const text = textOf(m?.content).trim();
	if (m?.role === "assistant" && Array.isArray(m.content)) {
		const calls = m.content
			.filter((c: any) => c?.type === "toolCall")
			.map((c: any) => `[tool call] ${c.name} ${JSON.stringify(c.arguments ?? {}).slice(0, TOOL_CALL_CHARS)}`);
		return [text, ...calls].filter(Boolean).join("\n");
	}
	if (m?.role === "toolResult" && text.length > TOOL_RESULT_CHARS) {
		return `${text.slice(0, TOOL_RESULT_CHARS)} [...${text.length - TOOL_RESULT_CHARS} chars truncated]`;
	}
	return text;
}

/**
 * Serialize every context message into a digest line — user, assistant (incl.
 * tool calls), and truncated tool results. Nothing the model saw may be lost
 * to the digest, so tool output is kept (capped) rather than dropped.
 */
export function transcriptTurns(messages: readonly any[]): DigestInput[] {
	const turns: DigestInput[] = [];
	(messages ?? []).forEach((m, i) => {
		const text = messageText(m);
		if (!text) return;
		const label = m.role === "toolResult" ? "TOOL RESULT" : String(m.role).toUpperCase();
		turns.push({ msgIndex: i, label, text });
	});
	return turns;
}

export function transcriptChars(turns: readonly DigestInput[]): number {
	return turns.reduce((n, t) => n + t.text.length, 0);
}

export interface DigestRequest {
	prompt: string;
	/**
	 * Count of leading input messages fully folded into the prompt. The caller
	 * keeps everything from this index verbatim — turns dropped by the budget
	 * are never silently lost.
	 */
	covered: number;
}

/** Oldest-first prefix fit to the budget; at least one turn so coverage always progresses. */
function fit(turns: readonly DigestInput[], cap: number): DigestInput[] {
	let total = 0;
	let k = 0;
	for (const t of turns) {
		if (k > 0 && total + t.text.length > cap) break;
		total += t.text.length;
		k++;
		if (total >= cap) break;
	}
	return turns.slice(0, k);
}

/**
 * Build the summariser request. Digests the OLDEST prefix that fits; the
 * caller leaves the newer remainder verbatim in the request, so the cap can
 * shrink the digest but never drop context. Returns undefined when there is
 * nothing to digest.
 */
export function digestPrompt(turns: readonly DigestInput[], maxInputChars: number): DigestRequest | undefined {
	const cap = maxInputChars ?? DEFAULTS.summaryMaxInputChars;
	const kept = fit(turns, cap);
	if (kept.length === 0) return undefined;
	const body = kept.map((t) => `${t.label}: ${t.text}`).join("\n\n");
	return {
		prompt: `${SYSTEM_PROMPT}\n\n--- TRANSCRIPT ---\n${body}`,
		covered: kept[kept.length - 1].msgIndex + 1,
	};
}

/** Refresh: fold the previous digest plus the oldest uncovered turns into one updated digest. */
export function digestMergePrompt(
	previousDigest: string,
	turns: readonly DigestInput[],
	maxInputChars: number,
): DigestRequest | undefined {
	const room = Math.max(1000, (maxInputChars ?? DEFAULTS.summaryMaxInputChars) - previousDigest.length);
	const req = digestPrompt(turns, room);
	if (!req) return undefined;
	req.prompt = `${req.prompt}\n\n--- PREVIOUS DIGEST (merge in anything not yet reflected) ---\n${previousDigest}`;
	return req;
}

export type SummarizeFn = (instructions: string, signal?: AbortSignal) => Promise<string>;

/** Shape of ExtensionContext["modelRegistry"].complete — must go through Pi for request-time auth. */
export type CompleteFn = (
	model: Model<any>,
	context: { messages: any[] },
	options: any,
) => Promise<{ content: unknown; stopReason?: string; errorMessage?: string }>;

/**
 * Build a summarize fn bound to a concrete model, or undefined when the
 * summariser is disabled / its model cannot be resolved. `complete` must be
 * Pi's authenticated `ctx.modelRegistry.complete` — direct pi-ai helpers only
 * resolve env-var keys, not Pi-configured credentials. Errors are swallowed by
 * the caller (RouterState) — digest is best-effort.
 */
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
	const timeoutMs = cfg.timeoutMs ?? DEFAULTS.summaryTimeoutMs;
	const level = cfg.thinkingLevel;
	return async (instructions: string, signal?: AbortSignal) => {
		const params: any = { maxTokens, timeoutMs, cacheRetention: "none" };
		if (level) params.reasoning = level;
		if (signal) params.signal = signal;
		const msg = await complete(model, { messages: [{ role: "user", content: instructions }] }, params);
		if (msg.stopReason === "error") throw new Error(msg.errorMessage || "summariser call failed");
		const text = textOf(msg.content).trim();
		if (!text) throw new Error("summariser returned an empty digest");
		return text;
	};
}
