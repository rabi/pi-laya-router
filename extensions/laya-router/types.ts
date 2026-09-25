export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteConfig {
	provider: string;
	model: string;
	description: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RoutingConfig {
	enabled?: boolean;
	maxPromptChars?: number;
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
}

export const DEFAULTS = {
	model: "laya",
	timeoutMs: 10000,
	minConfidence: 0.5,
	maxPromptChars: 8000,
	healthTimeoutMs: 8000,
} as const;
