import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layaHealth } from "./client.ts";
import { classify } from "./classifier.ts";
import { configPaths } from "./config.ts";
import type { RouterState } from "./router.ts";

const USAGE = [
	"/laya-router             status",
	"/laya-router on|off      toggle auto-routing",
	"/laya-router reload      re-read router.json",
	"/laya-router routes      routing table + last decision",
	"/laya-router reroute     drop the session lock; next prompt re-classifies",
	"/laya-router test <text> classify without switching",
	"/laya-router health      ping remote laya-serve",
].join("\n");

export async function handleRouterCommand(args: string, ctx: ExtensionContext, state: RouterState): Promise<void> {
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
			notify("laya-router: session lock cleared — next prompt re-classifies", "info");
			return;
		}
		case arg === "reload": {
			notify(state.cfg ? `laya-router: reloaded (${state.configPaths.join(", ")})` : "laya-router: reload failed", state.cfg ? "info" : "error");
			return;
		}
		case arg === "routes": {
			const lines = Object.entries(state.cfg!.routes).map(
				([name, r]) => `${name}: ${r.provider}/${r.model}${r.thinkingLevel ? ` [thinking=${r.thinkingLevel}]` : ""}`,
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
			notify(
				[
					`routing: ${state.enabled ? "on" : "off"} (mode: ${state.routingMode()})`,
					`serve: ${state.cfg!.serveUrl} (model ${state.cfg!.model ?? "laya"})`,
					`routes: ${Object.keys(state.cfg!.routes).join(", ")}`,
					state.currentBucket ? `current: ${state.currentBucket}` : "",
					`config: ${state.configPaths.join(", ") || "(none)"}`,
					`toggle with /laya-router on|off`,
				].join("\n"),
				"info",
			);
		}
	}
}

export { USAGE };
