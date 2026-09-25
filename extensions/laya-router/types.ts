export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteConfig {
	provider: string;
	model: string;
	description: string;
	thinkingLevel?: ThinkingLevel;
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
	/** intent-only: re-classify each prompt, switch only when clearly better */
	switchPolicy?: SwitchPolicyConfig;
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
}

export const DEFAULTS = {
	model: "laya",
	timeoutMs: 10000,
	minConfidence: 0.5,
	maxPromptChars: 8000,
	healthTimeoutMs: 8000,
	switchMargin: 0.15,
	switchMinAbsolute: 0.3,
	summaryMaxTokens: 1024,
	summaryTimeoutMs: 30000,
	summaryMinChars: 12000,
	summaryMaxInputChars: 60000,
	summaryRefreshTurns: 5,
} as const;
