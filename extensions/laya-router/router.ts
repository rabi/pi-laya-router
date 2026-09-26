import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, maxPromptChars } from "./config.ts";
import { classify, classifyState, scoreRoutes } from "./classifier.ts";
import { makeSummarizer, type SummarizeFn } from "./summarizer.ts";
import { calibratedSwitchDefaults, DEFAULTS, type Decision, type RouterConfig, type ThinkingLevel } from "./types.ts";
import { appendDecision } from "./decisionlog.ts";

/**
 * Mirror pi's prepareCompaction() no-op condition so compact() never throws
 * "Nothing to compact (session too small)": the summarizable span — entries
 * after the latest compaction — needs at least two user turns (below that the
 * cut never moves past the first cut point) and its message tokens must reach
 * keepRecentTokens (default 20k), since the cut only advances once the recent
 * tail fills that budget. Usage-based checks are wrong here: they include the
 * system prompt + tool schemas, while pi's budget counts session messages only.
 */
export function hasCompactableHistory(sessionManager: { buildSessionProjection: () => { entries: { sourceEntry: { type: string }; messages: any[] }[] } }): boolean {
	try {
		const entries = sessionManager.buildSessionProjection().entries;
		const prevCompactionIndex = entries.findIndex((e) => e.sourceEntry.type === "compaction" && e.messages.length > 0);
		const boundary = prevCompactionIndex >= 0 ? prevCompactionIndex + 1 : 0;
		let tokens = 0;
		let userTurns = 0;
		for (let i = boundary; i < entries.length; i++) {
			for (const m of entries[i].messages) {
				tokens += estimateTokens(m);
				if (m.role === "user") userTurns++;
			}
		}
		return userTurns >= 2 && tokens >= DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
	} catch {
		return false;
	}
}

export type RoutingMode = "classify" | "sticky" | "intent";

function marginFor(best: number, incumbent: number | undefined): string {
	return (incumbent === undefined ? best : best - incumbent).toFixed(3);
}

function excerpt(prompt: string, n = 160): string {
	const p = prompt.replace(/\s+/g, " ").trim();
	return p.length > n ? p.slice(0, n) + "…" : p;
}

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
	pinned: string | undefined;
	pinnedRoute: { provider: string; model: string } | undefined;
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
		this.pinned = undefined;
		this.pinnedRoute = undefined;
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
		this.pinned = undefined;
		this.pinnedRoute = undefined;
	}

	isPinned(): boolean {
		return this.pinned !== undefined;
	}

	/**
	 * Pin the session to a route name or a bare "provider/model", applying it
	 * immediately. Auto-routing stays paused until unlock().
	 */
	async pin(
		target: string,
		ctx: ExtensionContext,
		setModel: (m: NonNullable<ExtensionContext["model"]>) => Promise<boolean>,
		setThinkingLevel: (l: ThinkingLevel) => void,
		getThinkingLevel: () => ThinkingLevel,
	): Promise<string | undefined> {
		if (!this.cfg) return "no valid router.json";
		let name = target;
		let route = this.cfg.routes[target] ?? this.cfg.routes[target.toLowerCase()];
		if (!route && target.includes("/")) {
			const i = target.indexOf("/");
			const provider = target.slice(0, i);
			const model = target.slice(i + 1);
			if (!ctx.modelRegistry.find(provider, model)) {
				return `no route "${target}" and no model ${provider}/${model} in registry — routes: ${Object.keys(this.cfg.routes).join(", ")}`;
			}
			name = `${provider}/${model}`;
			route = { provider, model, description: "manual pin" };
		}
		if (!route) return `no route "${target}" — known: ${Object.keys(this.cfg.routes).join(", ")}`;
		const err = await this.apply(ctx, { bucket: name, confidence: 1, gated: false, route }, setModel, setThinkingLevel, getThinkingLevel);
		if (err === undefined) return `could not switch to ${route.provider}/${route.model}`;
		this.pinned = name;
		this.pinnedRoute = { provider: route.provider, model: route.model };
		appendDecision(this.cfg, { ts: new Date().toISOString(), prompt: "(manual)", outcome: "manual", bucket: name, route: `${route.provider}/${route.model}`, reason: "session pinned" });
		return undefined;
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
		if (this.pinned) {
			this.lastDecision = `pinned ${this.pinned} -> ${this.pinnedRoute?.provider}/${this.pinnedRoute?.model} (/laya-router unpin to release)`;
			return undefined;
		}
		const mode = this.routingMode();
		if (mode === "sticky" && this.locked) return undefined;

		// Tiny followups ("yes, do it") and data-heavy pastes (5KB of logs +
		// "analyze this") leave only a few words of classifiable prose — the
		// scores on that are near-noise, so keep the incumbent and skip the
		// laya round-trip. First prompt always routes (no incumbent to keep).
		const minSwitch = this.cfg.routing?.minSwitchChars ?? DEFAULTS.minSwitchChars;
		if (minSwitch > 0 && this.currentBucket && classifyState(prompt, maxPromptChars(this.cfg)).length < minSwitch) {
			this.lastDecision = `held ${this.currentBucket} (prompt signal < ${minSwitch} chars)`;
			appendDecision(this.cfg, { ts: new Date().toISOString(), prompt: excerpt(prompt), outcome: "hold", bucket: this.currentBucket, reason: `minSwitchChars < ${minSwitch}` });
			return undefined;
		}

		let decision: Decision | undefined;
		let scores: Record<string, number> | undefined;
		if (mode === "intent") {
			const r = await this.decideByMargin(prompt, signal);
			decision = r?.decision;
			scores = r?.scores;
		} else {
			decision = await classify(this.cfg, prompt, signal);
		}
		if (!decision?.route) return undefined;

		const switched = await this.apply(ctx, decision, setModel, setThinkingLevel, getThinkingLevel);
		appendDecision(this.cfg, {
			ts: new Date().toISOString(),
			prompt: excerpt(prompt),
			outcome: switched === undefined ? "error" : decision.gated ? "gate" : switched ? "switch" : "hold",
			bucket: decision.bucket,
			route: `${decision.route.provider}/${decision.route.model}`,
			confidence: decision.confidence,
			reason: decision.reason,
			probabilities: scores,
		});
		if (switched === undefined) return undefined;
		if (mode !== "intent") this.locked = true;
		return { decision, switched };
	}

	private async decideByMargin(
		prompt: string,
		signal?: AbortSignal,
	): Promise<{ decision: Decision | undefined; scores?: Record<string, number> }> {
		const cfg = this.cfg!;
		const scoreMap = await scoreRoutes(cfg, prompt, signal);
		const scores = Object.fromEntries(scoreMap);
		const cal = calibratedSwitchDefaults(Object.keys(cfg.routes).length);
		const margin = cfg.routing?.switchPolicy?.minMargin ?? cal.minMargin;
		const minAbs = cfg.routing?.switchPolicy?.minAbsolute ?? cal.minAbsolute;

		// Per-route minScore floor: a route below its own floor is ineligible, so
		// argmax over the rest naturally lands on the next-best qualifying route
		// rather than the default. The raw (unfloored) argmax is kept so the
		// decision log can say which route the floor actually demoted.
		const floorOf = (b: string) => cfg.routes[b]?.minScore;
		const eligible = (b: string, s: number) => {
			const f = floorOf(b);
			return f === undefined || s >= f;
		};
		let rawBest: string | undefined;
		let rawBestScore = -1;
		let best: string | undefined;
		let bestScore = -1;
		for (const [b, s] of scoreMap) {
			if (s > rawBestScore) {
				rawBest = b;
				rawBestScore = s;
			}
			if (!eligible(b, s)) continue;
			if (s > bestScore) {
				best = b;
				bestScore = s;
			}
		}
		const incumbent = this.currentBucket;
		const incumbentScore = incumbent !== undefined ? scoreMap.get(incumbent) : undefined;
		// An incumbent below its own floor loses margin protection: holding an
		// expensive model on marginal evidence is exactly what the floor prevents.
		const incumbentProtected = incumbent !== undefined && incumbentScore !== undefined && eligible(incumbent, incumbentScore);

		let bucket: string;
		let confidence: number;
		let gated = false;
		let reason: string;
		if (best === undefined) {
			bucket = incumbent ?? cfg.defaultRoute ?? "";
			confidence = rawBestScore;
			gated = true;
			reason = `no route clears its minScore floor (raw best "${rawBest}" ${rawBestScore.toFixed(3)})`;
		} else if (bestScore < minAbs) {
			bucket = incumbent ?? cfg.defaultRoute ?? "";
			confidence = bestScore;
			gated = true;
			reason = `best ${bestScore.toFixed(3)} < minAbsolute ${minAbs.toFixed(3)}`;
		} else if (
			incumbentProtected &&
			best !== incumbent &&
			bestScore - incumbentScore < margin
		) {
			bucket = incumbent;
			confidence = incumbentScore;
			reason = `margin ${marginFor(bestScore, incumbentScore)} < minMargin ${margin.toFixed(3)}`;
		} else {
			bucket = best;
			confidence = bestScore;
			reason = incumbent === undefined
				? "first prompt"
				: incumbentScore === undefined
					? `incumbent "${incumbent}" unscored (route removed?) — taking best "${best}"`
					: `margin ${marginFor(bestScore, incumbentScore)} >= minMargin ${margin.toFixed(3)}`;
			if (rawBest !== best) {
				gated = true;
				reason += `; "${rawBest}" below its minScore floor`;
			}
		}
		let route = cfg.routes[bucket];
		if (!route) {
			const dflt = cfg.defaultRoute ? cfg.routes[cfg.defaultRoute] : undefined;
			if (!dflt) return { decision: undefined, scores };
			reason = `bucket "${bucket}" not in routes; ${reason}`;
			bucket = cfg.defaultRoute!;
			route = dflt;
			gated = true;
		}
		return { decision: { bucket, confidence, gated, route, reason }, scores };
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
			// Gate: pi throws when there is nothing to compact (small session or
			// nothing new since the last compaction) — mirror its no-op condition.
			if (!this.compactingForSwitch && ctx.sessionManager && hasCompactableHistory(ctx.sessionManager)) {
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
