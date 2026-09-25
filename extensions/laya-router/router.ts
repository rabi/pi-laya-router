import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig } from "./config.ts";
import { classify, scoreRoutes } from "./classifier.ts";
import { makeSummarizer, type SummarizeFn } from "./summarizer.ts";
import { DEFAULTS, type Decision, type RouterConfig, type ThinkingLevel } from "./types.ts";

// pi's prepareCompaction() only yields a non-empty preparation once the
// summarized span passes its keepRecentTokens budget (default 20k); below
// that compact() throws "Nothing to compact (session too small)".
const COMPACT_MIN_TOKENS = 20000;

export type RoutingMode = "classify" | "sticky" | "intent";

export interface RouteResult {
	decision: Decision;
	switched: boolean;
}

export class RouterState {
	cfg: RouterConfig | undefined;
	configPaths: string[] = [];
	enabled = false;
	lastDecision = "";
	currentBucket: string | undefined;
	private warnedOnce = false;
	private manualToggle: boolean | undefined;
	private baselineThinkingLevel: ThinkingLevel | undefined;
	private locked = false;
	summarize: SummarizeFn | undefined;
	/** set when we triggered compact for a model switch; consumed by session_before_compact */
	compactingForSwitch = false;

	setEnabled(on: boolean): void {
		this.manualToggle = on;
		this.enabled = on;
	}

	reload(cwd: string, ctx?: ExtensionContext): boolean {
		try {
			const loaded = loadConfig(cwd);
			this.cfg = loaded.config;
			this.configPaths = loaded.paths;
			this.enabled = this.manualToggle ?? (loaded.config?.routing?.enabled ?? true);
			this.warnedOnce = false;
			this.summarize = ctx
				? makeSummarizer(
						loaded.config?.routing?.summarizer,
						(p, m) => ctx.modelRegistry.find(p, m),
						(m) => ctx.modelRegistry.hasConfiguredAuth(m),
						(m, c, o) => ctx.modelRegistry.complete(m, c, o) as any,
					)
				: undefined;
			if (!loaded.config && ctx) {
				ctx.ui.notify("pi-laya-router: no router.json found — checked ~/.pi/agent/router.json and .pi/router.json (see router.json.example)", "warning");
			}
			return !!loaded.config;
		} catch (err) {
			this.cfg = undefined;
			this.configPaths = [];
			if (ctx && !this.warnedOnce) {
				ctx.ui.notify(
					`pi-laya-router: invalid config — ${err instanceof ConfigError ? err.message : String(err)}`,
					"error",
				);
				this.warnedOnce = true;
			}
			return false;
		}
	}

	resetSession(): void {
		this.locked = false;
		this.currentBucket = undefined;
		this.lastDecision = "";
		this.compactingForSwitch = false;
	}

	routingMode(): RoutingMode {
		if (this.cfg?.routing?.stickySession) return "sticky";
		if (this.cfg?.routing?.switchPolicy === false) return "classify";
		return "intent";
	}

	unlock(): void {
		this.locked = false;
	}

	/** Classify prompt and switch model/thinking; skips setModel when already on target. */
	async route(
		ctx: ExtensionContext,
		prompt: string,
		setModel: (m: NonNullable<ExtensionContext["model"]>) => Promise<boolean>,
		setThinkingLevel: (l: ThinkingLevel) => void,
		getThinkingLevel: () => ThinkingLevel,
		signal?: AbortSignal,
	): Promise<RouteResult | undefined> {
		if (!this.cfg) return undefined;
		const mode = this.routingMode();
		if (mode === "sticky" && this.locked) return undefined;

		const decision =
			mode === "intent" ? await this.decideByMargin(prompt, signal) : await classify(this.cfg, prompt, signal);
		if (!decision?.route) return undefined;

		const switched = await this.apply(ctx, decision, setModel, setThinkingLevel, getThinkingLevel);
		if (switched === undefined) return undefined;
		if (mode !== "intent") this.locked = true;
		return { decision, switched };
	}

	private async decideByMargin(prompt: string, signal?: AbortSignal): Promise<Decision | undefined> {
		const cfg = this.cfg!;
		const scores = await scoreRoutes(cfg, prompt, signal);
		const margin = cfg.routing?.switchPolicy?.minMargin ?? DEFAULTS.switchMargin;
		const minAbs = cfg.routing?.switchPolicy?.minAbsolute ?? cfg.minConfidence ?? DEFAULTS.switchMinAbsolute;

		let best: string | undefined;
		let bestScore = -1;
		for (const [b, s] of scores) {
			if (s > bestScore) {
				best = b;
				bestScore = s;
			}
		}
		const incumbent = this.currentBucket;
		const incumbentScore = incumbent !== undefined ? scores.get(incumbent) : undefined;

		let bucket: string;
		let confidence: number;
		let gated = false;
		if (best === undefined || bestScore < minAbs) {
			bucket = incumbent ?? cfg.defaultRoute ?? "";
			confidence = bestScore;
			gated = true;
		} else if (
			incumbent !== undefined &&
			best !== incumbent &&
			incumbentScore !== undefined &&
			bestScore - incumbentScore < margin
		) {
			bucket = incumbent;
			confidence = incumbentScore;
		} else {
			bucket = best;
			confidence = bestScore;
		}
		const route = cfg.routes[bucket];
		if (route) return { bucket, confidence, gated, route };
		const dflt = cfg.defaultRoute ? cfg.routes[cfg.defaultRoute] : undefined;
		if (!dflt) return undefined;
		return { bucket: cfg.defaultRoute!, confidence, gated: true, route: dflt };
	}

	/** Returns true when the model changed, false when it stayed, undefined on failure. */
	private async apply(
		ctx: ExtensionContext,
		decision: Decision,
		setModel: (m: NonNullable<ExtensionContext["model"]>) => Promise<boolean>,
		setThinkingLevel: (l: ThinkingLevel) => void,
		getThinkingLevel: () => ThinkingLevel,
	): Promise<boolean | undefined> {
		const model = ctx.modelRegistry.find(decision.route.provider, decision.route.model);
		if (!model) {
			ctx.ui.notify(`laya-router: model ${decision.route.provider}/${decision.route.model} not found in registry`, "warning");
			return undefined;
		}
		const current = ctx.model;
		const sameModel = !!(current && current.id === model.id && current.provider === model.provider);
		if (!sameModel && !(await setModel(model))) {
			ctx.ui.notify(`laya-router: no API key for ${decision.route.provider}/${decision.route.model}`, "warning");
			return undefined;
		}
		if (decision.route.thinkingLevel) {
			if (this.baselineThinkingLevel === undefined) this.baselineThinkingLevel = getThinkingLevel();
			setThinkingLevel(decision.route.thinkingLevel);
		} else if (this.baselineThinkingLevel !== undefined) {
			setThinkingLevel(this.baselineThinkingLevel);
		}
		const switched = !sameModel;
		if (switched) {
			// Trigger pi's compaction — the new model's prompt cache is cold anyway,
			// a compacted transcript beats replaying the full raw history.
			// The session_before_compact handler intercepts to use the cheap model.
			// Gate on context size: on a small session pi has nothing to compact and throws.
			const usage = ctx.getContextUsage?.();
			if (!this.compactingForSwitch && usage?.tokens != null && usage.tokens >= COMPACT_MIN_TOKENS) {
				this.compactingForSwitch = true;
				ctx.compact({
					customInstructions: "Model switch: preserve current task state, file changes, and open questions.",
					onComplete: () => {
						this.compactingForSwitch = false;
					},
					onError: () => {
						this.compactingForSwitch = false;
					},
				});
			}
		}
		this.currentBucket = decision.bucket;
		this.lastDecision = `${decision.bucket} (${decision.confidence.toFixed(2)}${decision.gated ? ", gated" : ""}) -> ${decision.route.provider}/${decision.route.model}`;
		return switched;
	}
}
