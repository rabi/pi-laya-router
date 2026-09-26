import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layaHealth } from "./client.ts";
import { classify } from "./classifier.ts";
import { configPaths } from "./config.ts";
import { fmtProbs, tailDecisions } from "./decisionlog.ts";
import { calibratedSwitchDefaults, DEFAULTS, type ThinkingLevel } from "./types.ts";
import type { RouterState } from "./router.ts";

const USAGE = [
	"/laya-router             status",
	"/laya-router on|off      toggle auto-routing",
	"/laya-router reload      re-read router.json",
	"/laya-router routes      routing table + last decision",
	"/laya-router reroute     force re-classification on the next prompt",
	"/laya-router pin <route|provider/model>  pin the session (no auto-routing)",
	"/laya-router unpin       release the session pin",
	"/laya-router test <text> classify without switching",
	"/laya-router health      ping remote laya-serve",
].join("\n");

export interface ModelControls {
	setModel: (m: NonNullable<ExtensionContext["model"]>) => Promise<boolean>;
	setThinkingLevel: (l: ThinkingLevel) => void;
	getThinkingLevel: () => ThinkingLevel;
}

export async function handleRouterCommand(
	args: string,
	ctx: ExtensionContext,
	state: RouterState,
	models?: ModelControls,
): Promise<void> {
	const notify = ctx.ui.notify.bind(ctx.ui);
	const arg = args.trim();

	if (arg === "reload" || (arg === "" && !state.cfg)) state.reload(ctx.cwd, ctx);
	if (!state.cfg && arg !== "reload") {
		notify(`no valid router.json. Checked:\n${configPaths(ctx.cwd).join("\n")}\nUsage:\n${USAGE}`, "error");
		return;
	}

	switch (true) {
		case arg === "on":
		case arg === "off": {
			state.setEnabled(arg === "on");
			notify(`laya-router: auto-routing ${arg}`, "info");
			return;
		}
		case arg === "reroute": {
			state.unlock();
			state.currentBucket = undefined;
			notify("laya-router: incumbent cleared — next prompt re-classifies from scratch", "info");
			return;
		}
		case arg === "pin" || arg.startsWith("pin "): {
			const bucket = arg.slice(3).trim();
			if (!bucket) {
				notify(`usage: /laya-router pin <${Object.keys(state.cfg?.routes ?? {}).join("|")}>`, "warning");
				return;
			}
			if (!models) {
				notify("laya-router: pin unavailable in this context", "error");
				return;
			}
			const err = await state.pin(bucket, ctx, models.setModel, models.setThinkingLevel, models.getThinkingLevel);
			if (err) notify(`laya-router: ${err}`, "error");
			else notify(`laya-router: session pinned to ${bucket} — auto-routing paused until /laya-router unpin`, "info");
			return;
		}
		case arg === "unpin": {
			state.unlock();
			notify("laya-router: pin released — auto-routing resumes", "info");
			return;
		}
		case arg === "reload": {
			if (!state.cfg) {
				notify("laya-router: reload failed", "error");
				return;
			}
			notify(`laya-router: reloaded (${state.configPaths.join(", ")})\n${policyLine(state)}`, "info");
			return;
		}
		case arg === "routes": {
			const lines = Object.entries(state.cfg!.routes).map(
				([name, r]) => `${name}: ${r.provider}/${r.model}${r.thinkingLevel ? ` [thinking=${r.thinkingLevel}]` : ""}${r.minScore !== undefined ? ` [minScore=${r.minScore}]` : ""}`,
			);
			lines.push(`default: ${state.cfg!.defaultRoute ?? "(none)"} | minConfidence: ${state.cfg!.minConfidence ?? 0.5}`);
			if (state.lastDecision) lines.push(`last: ${state.lastDecision}`);
			notify(lines.join("\n"), "info");
			return;
		}
		case arg === "health": {
			try {
				notify(`laya-serve /health — ${await layaHealth(state.cfg!)}`, "info");
			} catch (err) {
				notify(`${err instanceof Error ? err.message : String(err)}`, "error");
			}
			return;
		}
		case arg === "test" || arg.startsWith("test "): {
			const text = arg.slice(4).trim();
			if (!text) {
				notify("usage: /laya-router test <text>", "warning");
				return;
			}
			try {
				const d = await classify(state.cfg!, text);
				notify(
					d
						? `route=${d.bucket} confidence=${d.confidence.toFixed(3)}${d.gated ? ` (gated to default; raw confidence < ${state.cfg!.minConfidence ?? 0.5})` : ""}${d.route ? ` -> ${d.route.provider}/${d.route.model}` : ""}`
						: "no answer from laya-serve",
					"info",
				);
			} catch (err) {
				notify(`${err instanceof Error ? err.message : String(err)}`, "error");
			}
			return;
		}
		default: {
			if (arg) {
				notify(`unknown subcommand "${arg}"\n${USAGE}`, "warning");
				return;
			}
			const recent = tailDecisions(state.cfg!, 5)
				.reverse()
				.map((d) => `${d.ts.slice(11, 19)} ${d.outcome} ${d.bucket}${d.confidence !== undefined ? ` (${d.confidence.toFixed(2)})` : ""} — ${d.reason ?? ""}${d.probabilities ? ` [${fmtProbs(d.probabilities)}]` : ""} "${d.prompt.slice(0, 40)}"`);
			notify(
				[
					`routing: ${state.enabled ? "on" : "off"} (mode: ${state.routingMode()})`,
					`serve: ${state.cfg!.serveUrl} (model ${state.cfg!.model ?? "laya"})`,
					policyLine(state),
					state.isPinned() ? `PINNED: ${state.pinned} (/laya-router unpin to release)` : state.currentBucket ? `current: ${state.currentBucket}` : "",
					state.lastDecision ? `last: ${state.lastDecision}` : "",
					`config: ${state.configPaths.join(", ") || "(none)"}`,
					recent.length ? `recent decisions:\n${recent.join("\n")}` : "no decisions logged yet",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		}
	}
}

export { USAGE };

function policyLine(state: RouterState): string {
	const cfg = state.cfg!;
	if (cfg.routing?.stickySession) return "policy: sticky session (first prompt locks)";
	if (cfg.routing?.switchPolicy === false) return "policy: classify-every-prompt (no gate)";
	const cal = calibratedSwitchDefaults(Object.keys(cfg.routes).length);
	const m = cfg.routing?.switchPolicy?.minMargin ?? cal.minMargin;
	const a = cfg.routing?.switchPolicy?.minAbsolute ?? cal.minAbsolute;
	const def = (v: number, c: number) => `${v.toFixed(3)}${Math.abs(v - c) < 1e-9 ? " (default)" : ""}`;
	return `policy: minMargin>=${def(m, cal.minMargin)} minAbsolute>=${def(a, cal.minAbsolute)} minSwitchChars=${cfg.routing?.minSwitchChars ?? DEFAULTS.minSwitchChars}`;
}
