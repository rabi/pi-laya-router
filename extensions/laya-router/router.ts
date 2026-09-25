import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig } from "./config.ts";
import { classify, scoreRoutes } from "./classifier.ts";
import { digestMergePrompt, digestPrompt, makeSummarizer, transcriptChars, transcriptTurns, type SummarizeFn } from "./summarizer.ts";
import { DEFAULTS, type Decision, type RouterConfig, type ThinkingLevel } from "./types.ts";

export const DIGEST_MARKER = "[laya-router conversation digest]";

export type RoutingMode = "classify" | "sticky" | "intent";

export interface RouteResult {
	decision: Decision;
	/** true when the model actually changed */
	switched: boolean;
}

function digestMessage(digest: string): any {
	return { role: "user", content: `${DIGEST_MARKER}\n${digest}` };
}

function isDigestMessage(m: any): boolean {
	if (m?.role !== "user") return false;
	return typeof m.content === "string" && m.content.startsWith(DIGEST_MARKER);
}

function countUserTurns(messages: readonly any[]): number {
	return messages.filter((m: any) => m?.role === "user" && !isDigestMessage(m)).length;
}

function lastUserIndex(messages: readonly any[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user" && !isDigestMessage(messages[i])) return i;
	}
	return -1;
}

export class RouterState {
	cfg: RouterConfig | undefined;
	configPaths: string[] = [];
	enabled = false;
	lastDecision = "";
	/** bucket of the route currently applied to this session */
	currentBucket: string | undefined;
	private warnedOnce = false;
	private manualToggle: boolean | undefined;
	private baselineThinkingLevel: ThinkingLevel | undefined;
	private locked = false;
	private summarize: SummarizeFn | undefined;
	private digest: string | undefined;
	/** how many leading history messages are folded into `digest` */
	private digestCovered = 0;
	private digestPending = false;
	private digestFailures = 0;

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

	/** Reset per-session state (call on session_start). */
	resetSession(): void {
		this.locked = false;
		this.currentBucket = undefined;
		this.digest = undefined;
		this.digestCovered = 0;
		this.digestPending = false;
		this.digestFailures = 0;
		this.lastDecision = "";
	}

	routingMode(): RoutingMode {
		if (this.cfg?.routing?.stickySession) return "sticky";
		if (this.cfg?.routing?.switchPolicy) return "intent";
		return "classify";
	}

	/** Clear the lock so the next prompt re-classifies (manual re-route / toggle on). */
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
		// session lock: the first prompt chose the model — ride the prompt cache out
		if (mode === "sticky" && this.locked) return undefined;

		const decision =
			mode === "intent" ? await this.decideByMargin(prompt, signal) : await classify(this.cfg, prompt, signal);
		if (!decision?.route) return undefined;

		const switched = await this.apply(ctx, decision, setModel, setThinkingLevel, getThinkingLevel);
		if (switched === undefined) return undefined;
		if (mode !== "intent") this.locked = true;
		return { decision, switched };
	}

	/** Compare incumbent vs challenger in one laya pass; switch only on a clear margin. */
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
			// nothing confident: keep incumbent, else default — don't thrash
			bucket = incumbent ?? cfg.defaultRoute ?? "";
			confidence = bestScore;
			gated = true;
		} else if (
			incumbent !== undefined &&
			best !== incumbent &&
			incumbentScore !== undefined &&
			bestScore - incumbentScore < margin
		) {
			// challenger wins but not decisively — incumbent keeps the cache
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
		// a model switch invalidates the new model's prompt cache anyway —
		// a cheap-model digest of history beats replaying the raw transcript to it
		if (switched && this.summarize) this.digestPending = true;
		this.currentBucket = decision.bucket;
		this.lastDecision = `${decision.bucket} (${decision.confidence.toFixed(2)}${decision.gated ? ", gated" : ""}) -> ${decision.route.provider}/${decision.route.model}`;
		return switched;
	}

	/**
	 * `context` event handler. Once a digest exists, each request becomes
	 * [digest] + [history not yet covered by it] + [current turn]. The stored
	 * transcript is untouched — this reshapes the request only, and re-applies
	 * on every LLM call within the turn (tool loops included).
	 */
	async transformContext(messages: readonly any[], signal?: AbortSignal): Promise<{ messages: any[] } | undefined> {
		const sumCfg = this.cfg?.routing?.summarizer;
		if (!sumCfg || sumCfg.enabled === false) return undefined;

		const cut = lastUserIndex(messages);
		if (cut < 0) return undefined;
		const history = messages.slice(0, cut).filter((m: any) => !isDigestMessage(m));
		const uncoveredOf = () => history.slice(Math.min(this.digestCovered, history.length));
		let uncovered = uncoveredOf();
		const refreshTurns = sumCfg.refreshTurns ?? DEFAULTS.summaryRefreshTurns;

		const canSummarize = this.summarize !== undefined && this.digestFailures < 2;
		// within a turn history is stable, so uncovered stays empty and no re-fire happens
		const wantBuild =
			!this.digest && this.digestPending && canSummarize &&
			transcriptChars(transcriptTurns(history)) >= (sumCfg.minChars ?? DEFAULTS.summaryMinChars);
		const wantRefresh =
			!!this.digest && canSummarize &&
			(this.digestPending || countUserTurns(uncovered) >= refreshTurns);

		if (wantBuild || wantRefresh) {
			const turns = transcriptTurns(history);
			const prompt =
				wantRefresh && this.digest
					? digestMergePrompt(this.digest, turns, sumCfg.maxInputChars ?? DEFAULTS.summaryMaxInputChars)
					: digestPrompt(turns, sumCfg.maxInputChars ?? DEFAULTS.summaryMaxInputChars);
			try {
				this.digest = await this.summarize!(prompt, signal);
				this.digestCovered = history.length;
				this.digestPending = false;
				uncovered = uncoveredOf();
			} catch {
				this.digestFailures += 1;
				// stale digest + uncovered tail still loses nothing; stop retrying at >=2
			}
		} else if (!this.digest && this.digestPending && this.summarize && this.digestFailures < 2) {
			// history too small to be worth a digest — clear the one-shot flag
			this.digestPending = false;
		}

		if (!this.digest) return undefined;
		return { messages: [digestMessage(this.digest), ...uncovered, ...messages.slice(cut)] };
	}
}
