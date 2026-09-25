/**
 * pi-laya-router — Laya decision tools + prompt-based model routing for pi.
 *
 * Structure:
 * - types.ts      shared interfaces + defaults
 * - config.ts     JSONC config loading, deep merge, env override, validation
 * - client.ts     laya-serve HTTP client (/v1/systemone, /health)
 * - classifier.ts prompt -> route bucket via laya choice question
 * - router.ts     RouterState: config lifecycle + model switching
 * - tools.ts      laya_ask / laya_classify / laya_check / laya_score / laya_health
 * - commands.ts   /laya-router subcommand handling
 *
 * Config: ~/.pi/agent/router.json overridden by <cwd>/.pi/router.json,
 * with LAYA_SERVE_URL / LAYA_API_KEY env overrides. See router.json.example.
 */

import { buildTools } from "./laya-router/tools.ts";
import { handleRouterCommand } from "./laya-router/commands.ts";
import { RouterState } from "./laya-router/router.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const state = new RouterState();

	for (const tool of buildTools(() => state.cfg)) pi.registerTool(tool);

	pi.on("session_start", async (_event, ctx) => {
		state.reload(ctx.cwd, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.cfg || !state.enabled || !event.prompt.trim()) return;
		try {
			const decision = await state.route(
				ctx,
				event.prompt,
				(m) => pi.setModel(m),
				(l) => pi.setThinkingLevel(l),
				() => pi.getThinkingLevel(),
				ctx.signal,
			);
			if (decision) ctx.ui.notify(`laya-router: ${state.lastDecision}`, "info");
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") return;
			ctx.ui.notify(
				`laya-router: routing skipped (${String(err instanceof Error ? err.message : err).slice(0, 160)})`,
				"warning",
			);
		}
	});

	pi.registerCommand("laya-router", {
		description: "Laya model router: status | on | off | reload | routes | test <text> | health",
		handler: async (args: string, ctx: ExtensionContext) => handleRouterCommand(args, ctx, state),
	});
}
