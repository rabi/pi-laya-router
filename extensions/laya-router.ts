/**
 * pi-laya-router — Laya decision tools + prompt-based model routing for pi.
 *
 * On model switch, triggers pi's native compaction (intercepted via
 * session_before_compact to route the summary through a cheap model).
 *
 * Structure:
 * - types.ts      shared interfaces + defaults
 * - config.ts     JSONC config loading, deep merge, env override, validation
 * - client.ts     laya-serve HTTP client (/v1/systemone, /health)
 * - classifier.ts prompt -> route bucket via laya choice question
 * - summarizer.ts  cheap-model transcript digest for model switches
 * - router.ts     RouterState: sticky / intent-only routing + compact trigger
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
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const state = new RouterState();

	for (const tool of buildTools(() => state.cfg)) pi.registerTool(tool);

	pi.on("session_start", async (_event, ctx) => {
		state.resetSession();
		state.reload(ctx.cwd, ctx);
	});

	pi.on("session_compact", async (event) => {
		state.compactingForSwitch = false;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Only intercept when this compaction was triggered by a model switch
		// (always reason "manual") AND we have a cheap summarizer configured.
		// Otherwise let pi do its default.
		if (!state.compactingForSwitch || event.reason !== "manual" || !state.summarize) return undefined;

		const { preparation, signal } = event;
		try {
			// Serialize all messages to be summarized (including split-turn prefix)
			const allMessages = [
				...preparation.messagesToSummarize,
				...preparation.turnPrefixMessages,
			];
			if (allMessages.length === 0) return undefined;

			const transcript = serializeConversation(convertToLlm(allMessages));
			const { summary, usage } = await state.summarize(transcript, preparation.previousSummary, signal);

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage,
				},
			};
		} catch (err) {
			ctx.ui.notify(
				`laya-router: cheap-model compaction failed, falling back to default (${String(err).slice(0, 120)})`,
				"warning",
			);
			// Return undefined → pi does its default compaction with the current model
			return undefined;
		}
	});

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

	pi.registerCommand("laya-router", {
		description: "Laya model router: status | on | off | reload | routes | test <text> | health",
		handler: async (args: string, ctx: ExtensionContext) => handleRouterCommand(args, ctx, state),
	});
}
