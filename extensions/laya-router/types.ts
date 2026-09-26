export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteConfig {
	provider: string;
	model: string;
	description: string;
	thinkingLevel?: ThinkingLevel;
	/**
	 * Per-route score floor: this route is only selected when its own score
	 * reaches minScore (probability in intent mode, answer_confidence in
	 * classify mode). For expensive models that should only run on clear
	 * intent. Below the floor the route is ineligible — the next-best eligible
	 * route wins instead of the default — and an incumbent sitting below its
	 * own floor loses margin protection.
	 */
	minScore?: number;
}

export interface SwitchPolicyConfig {
	/** confidence gap the challenger route must beat the incumbent by */
	minMargin?: number;
	/** incumbent fell below this → switch to best route regardless of margin */
	minAbsolute?: number;
}

export interface SummarizerConfig {
	enabled?: boolean;
	provider?: string;
	model?: string;
	/** "off" recommended: thinking models spend the maxTokens budget on reasoning and can return an empty digest */
	thinkingLevel?: ThinkingLevel;
	maxTokens?: number;
	timeoutMs?: number;
	/** only summarise when the transcript is at least this large */
	minChars?: number;
	/** cap on transcript chars fed to the summariser */
	maxInputChars?: number;
	/** re-summarise at most every N user turns */
	refreshTurns?: number;
}

export interface RoutingConfig {
	enabled?: boolean;
	maxPromptChars?: number;
	/** session lock: classify first prompt, then ride it out (sticky) */
	stickySession?: boolean;
	/**
	 * Default mode (unless stickySession): re-classify each prompt, switch only
	 * when a challenger beats the incumbent by minMargin. Set to false to opt
	 * back into raw classify-every-prompt routing (switch on any change).
	 */
	switchPolicy?: SwitchPolicyConfig | false;
	/**
	 * Append every routing decision (prompt excerpt, full probability map,
	 * gate that fired, outcome) to a JSONL file for later audit.
	 * Path override: "decisionLogPath" (default <agentDir>/laya-router-decisions.jsonl).
	 */
	decisionLog?: boolean;
	decisionLogPath?: string;
	/**
	 * If the classifiable signal (prose left after code stripping — what laya
	 * would actually see) is under this many chars, keep the incumbent and skip
	 * the laya call entirely. Tiny followups ("yes, do it") and data-heavy
	 * pastes (5KB of logs + "analyze this") are near-noise for switching.
	 * Only applies when an incumbent exists; the first prompt always routes.
	 * 0 disables the gate.
	 */
	minSwitchChars?: number;
	/** stateful summarisation: replace history with a cheap-model digest on switch */
	summarizer?: SummarizerConfig;
}

export interface RouterConfig {
	serveUrl: string;
	apiKey?: string;
	model?: string;
	timeoutMs?: number;
	minConfidence?: number;
	defaultRoute?: string;
	routing?: RoutingConfig;
	routes: Record<string, RouteConfig>;
}

export interface LoadedConfig {
	config: RouterConfig | undefined;
	paths: string[];
}

export interface Decision {
	bucket: string;
	confidence: number;
	/** true when the raw bucket was replaced by defaultRoute due to low confidence */
	gated: boolean;
	route?: RouteConfig;
	/** laya's full probability map, when returned */
	probabilities?: Record<string, number>;
	/** why this bucket was picked (gate fired, margin math) */
	reason?: string;
}

export const DEFAULTS = {
	model: "laya",
	timeoutMs: 10000,
	minConfidence: 0.5,
	maxPromptChars: 8000,
	healthTimeoutMs: 8000,

	minSwitchChars: 40,
	summaryMaxTokens: 1024,
	summaryTimeoutMs: 30000,
	summaryMinChars: 12000,
	summaryMaxInputChars: 60000,
	summaryRefreshTurns: 5,
} as const;

/**
 * Switch-gate defaults calibrated to the number of routes N. Laya's 4-way
 * distributions sit near the uniform prior (1/N = 0.25), so absolute gates far
 * above 1/N fire on most prompts and a fixed margin above the typical
 * clear-case gap (0.05-0.15 measured on a 4-route table) pins the incumbent
 * forever. Defaults scale with the prior: margin ~ 1/(4N), minAbsolute ~ 1/N
 * plus a small signal margin, both clamped to sane ranges.
 */
export function calibratedSwitchDefaults(n: number): { minMargin: number; minAbsolute: number } {
	return {
		minMargin: Math.min(0.15, Math.max(0.03, 0.25 / n)),
		minAbsolute: Math.min(0.4, Math.max(0.2, 1 / n + 0.03)),
	};
}
