import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig } from "./config.ts";
import { classify } from "./classifier.ts";
import type { Decision, RouterConfig, ThinkingLevel } from "./types.ts";

export class RouterState {
	cfg: RouterConfig | undefined;
	configPaths: string[] = [];
	enabled = false;
	lastDecision = "";
	private warnedOnce = false;
	private manualToggle: boolean | undefined;
	private baselineThinkingLevel: ThinkingLevel | undefined;

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

	/** Classify prompt and switch model; returns the decision when a switch happened. */
	async route(
		ctx: ExtensionContext,
		prompt: string,
		setModel: (m: NonNullable<ExtensionContext["model"]>) => Promise<boolean>,
		setThinkingLevel: (l: ThinkingLevel) => void,
		getThinkingLevel: () => ThinkingLevel,
		signal?: AbortSignal,
	): Promise<Decision | undefined> {
		if (!this.cfg) return undefined;
		const decision = await classify(this.cfg, prompt, signal);
		if (!decision?.route) return undefined;

		const model = ctx.modelRegistry.find(decision.route.provider, decision.route.model);
		if (!model) {
			ctx.ui.notify(`laya-router: model ${decision.route.provider}/${decision.route.model} not found in registry`, "warning");
			return undefined;
		}
		const current = ctx.model;
		if (current && current.id === model.id && current.provider === model.provider) return undefined;
		if (!(await setModel(model))) {
			ctx.ui.notify(`laya-router: no API key for ${decision.route.provider}/${decision.route.model}`, "warning");
			return undefined;
		}
		if (decision.route.thinkingLevel) {
			if (this.baselineThinkingLevel === undefined) this.baselineThinkingLevel = getThinkingLevel();
			setThinkingLevel(decision.route.thinkingLevel);
		} else if (this.baselineThinkingLevel !== undefined) {
			setThinkingLevel(this.baselineThinkingLevel);
		}
		this.lastDecision = `${decision.bucket} (${decision.confidence.toFixed(2)}${decision.gated ? ", gated" : ""}) -> ${decision.route.provider}/${decision.route.model}`;
		return decision;
	}
}
