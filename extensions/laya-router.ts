/**
 * pi-laya-router — Laya decision tools + prompt-based model routing for pi.
 *
 * Structure:
 * - types.ts      shared interfaces + defaults
 * - config.ts     JSONC config loading, deep merge, env override, validation
 * - client.ts     laya-serve HTTP client (/v1/systemone, /health)
 * - classifier.ts prompt -> route bucket via laya choice question
 * - summarizer.ts  cheap-model transcript digest for model switches
 * - router.ts     RouterState: sticky / intent-only routing + digest context rewrite
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
	// the digest call itself must not be routed or re-summarised
	let summarizing = false;

	for (const tool of buildTools(() => state.cfg)) pi.registerTool(tool);

	pi.on("session_start", async (_event, ctx) => {
		state.resetSession();
		state.reload(ctx.cwd, ctx);
	});

	// pi rebuilt the transcript (compaction summary or /tree navigation) —
	// message indices the digest was anchored to no longer line up
	pi.on("session_compact", async () => state.resetDigest());
	pi.on("session_tree", async () => state.resetDigest());

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.cfg || !state.enabled || !event.prompt.trim()) return;
		try {
			const result = await state.route(
				ctx,
				event.prompt,
				(m) => pi.setModel(m),
				(l) => pi.setThinkingLevel(l),
				() => pi.getThinkingLevel(),
				ctx.signal,
			);
			if (result) ctx.ui.notify(`laya-router: ${state.lastDecision}`, "info");
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") return;
			ctx.ui.notify(
				`laya-router: routing skipped (${String(err instanceof Error ? err.message : err).slice(0, 160)})`,
				"warning",
			);
		}
	});

	pi.on("context", async (event, ctx) => {
		if (!state.cfg || !state.enabled || summarizing) return undefined;
		summarizing = true;
		try {
			return await state.transformContext(event.messages, ctx.signal);
		}
		catch { return undefined; }
		finally { summarizing = false; }
	});

	pi.registerCommand("laya-router", {
		description: "Laya model router: status | on | off | reload | routes | test <text> | health",
		handler: async (args: string, ctx: ExtensionContext) => handleRouterCommand(args, ctx, state),
	});
}
