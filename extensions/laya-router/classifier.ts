import { layaAsk } from "./client.ts";
import { maxPromptChars } from "./config.ts";
import type { Decision, RouterConfig } from "./types.ts";

export const CLASSIFY_INSTRUCTIONS = "Which category best fits this request?";

export function routeCriteria(cfg: RouterConfig): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, route] of Object.entries(cfg.routes)) out[name] = route.description;
	return out;
}

function isCodeLine(line: string): boolean {
	const codeChars = (line.match(/[{}();=><]/g) ?? []).length;
	return codeChars / line.length > 0.1;
}

// laya's single forward pass drowns the trailing question when the state
// carries a code block (measured: ~700 chars of code + "review this" scores
// identically to the code alone). The request lives in the prose — drop code
// payload always, not just when over the length limit.
export function classifyState(prompt: string, limit: number): string {
	if (prompt.length <= limit && !prompt.includes("```")) return prompt;
	const lines: string[] = [];
	let inFence = false;
	for (const raw of prompt.split("\n")) {
		const t = raw.trim();
		if (t.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !t || isCodeLine(t)) continue;
		lines.push(t);
	}
	const prose = lines.join("\n");
	if (prose.length >= 20) return prose.slice(0, limit);
	// no usable prose: tail slice beats head — intent tends to sit at the end
	return prompt.slice(-limit);
}

export async function classify(
	cfg: RouterConfig,
	prompt: string,
	signal?: AbortSignal,
): Promise<Decision | undefined> {
	const state = classifyState(prompt, maxPromptChars(cfg));
	const data = await layaAsk<{ answers: Record<string, { choice?: string; confidence?: number; answer_confidence?: number }> }>(
		cfg,
		{
			state,
			questions: {
				route: { type: "choice", instructions: CLASSIFY_INSTRUCTIONS, criteria: routeCriteria(cfg) },
			},
		},
		signal,
	);
	const ans = data.answers?.route;
	if (!ans?.choice) return undefined;
	// laya's `confidence` is a concentration statistic (runner-up spread), not
	// P(correct) — with many routes it sits low even on clear-cut answers.
	// `answer_confidence` is the probability mass on the chosen label.
	const confidence = ans.answer_confidence ?? ans.confidence ?? 0;

	// Unknown or low-confidence labels fall back to defaultRoute — small models
	// hallucinate bucket names, and the gate exists for exactly these answers.
	let bucket = ans.choice;
	let gated = false;
	const minConf = cfg.minConfidence ?? 0.5;
	if ((!cfg.routes[bucket] || confidence < minConf) && cfg.defaultRoute && cfg.routes[cfg.defaultRoute]) {
		bucket = cfg.defaultRoute;
		gated = true;
	}
	if (!cfg.routes[bucket]) return undefined;
	return { bucket, confidence, gated, route: cfg.routes[bucket] };
}
