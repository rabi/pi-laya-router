import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { compact, layaAsk, layaHealth } from "./client.ts";
import type { RouterConfig } from "./types.ts";

/**
 * Builds the four decision tools. `getConfig` returns undefined while config is
 * broken/absent; the message guides the user to a fix instead of a bare throw.
 */
export function buildTools(getConfig: () => RouterConfig | undefined) {
	const requireCfg = (): RouterConfig => {
		const cfg = getConfig();
		if (!cfg) {
			throw new Error(
				'pi-laya-router: no valid config. Create ~/.pi/agent/router.json (serveUrl + routes) — see router.json.example, then run /laya-router to verify.',
			);
		}
		return cfg;
	};

	const askTool = defineTool({
		name: "laya_ask",
		label: "Laya Ask",
		description:
			"Run typed System-1 questions (choice/score/noul) over one state in a single forward pass on a remote Laya model. Confidence is a concentration statistic, not probability of correctness. Not for generating text.",
		parameters: Type.Object({
			state: Type.String({ description: "Text/state to evaluate" }),
			questions: Type.Record(Type.String(), Type.Any(), {
				description:
					'Map question id -> {type: "choice"|"score"|"noul", instructions, criteria? (choice), levels? (score 2-10)}',
			}),
		}),
		async execute(_id, params, signal) {
			const data = await layaAsk(requireCfg(), { state: params.state, questions: params.questions }, signal);
			return { content: [{ type: "text", text: compact(data) }], details: undefined };
		},
	});

	const classifyTool = defineTool({
		name: "laya_classify",
		label: "Laya Classify",
		description: "Classify a state into one of the given categories. Returns label + probability distribution.",
		parameters: Type.Object({
			state: Type.String(),
			criteria: Type.Record(Type.String(), Type.String(), {
				description: "Map label -> description of that category",
			}),
			instructions: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal) {
			const data = await layaAsk(
				requireCfg(),
				{
					state: params.state,
					questions: {
						classification: {
							type: "choice",
							instructions: params.instructions ?? "Which category best describes the state?",
							criteria: params.criteria,
						},
					},
				},
				signal,
			);
			return { content: [{ type: "text", text: compact(data) }], details: undefined };
		},
	});

	const checkTool = defineTool({
		name: "laya_check",
		label: "Laya Check",
		description: "Answer one yes/no (noul) question about a state. Returns P(true); branch on it directly.",
		parameters: Type.Object({
			state: Type.String(),
			question: Type.String({ description: "Yes/no question about the state" }),
		}),
		async execute(_id, params, signal) {
			const data = await layaAsk(
				requireCfg(),
				{ state: params.state, questions: { check: { type: "noul", instructions: params.question } } },
				signal,
			);
			return { content: [{ type: "text", text: compact(data) }], details: undefined };
		},
	});

	const scoreTool = defineTool({
		name: "laya_score",
		label: "Laya Score",
		description: "Rate a state on an ordered scale (2-10 levels).",
		parameters: Type.Object({
			state: Type.String(),
			question: Type.String(),
			levels: Type.Optional(Type.Number({ minimum: 2, maximum: 10 })),
		}),
		async execute(_id, params, signal) {
			const data = await layaAsk(
				requireCfg(),
				{
					state: params.state,
					questions: {
						rating: { type: "score", instructions: params.question, levels: params.levels ?? 5 },
					},
				},
				signal,
			);
			return { content: [{ type: "text", text: compact(data) }], details: undefined };
		},
	});

	const healthTool = defineTool({
		name: "laya_health",
		label: "Laya Health",
		description: "Remote laya-serve health (loaded checkpoints, device). No inference.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			return { content: [{ type: "text", text: await layaHealth(requireCfg(), signal) }], details: undefined };
		},
	});

	return [askTool, classifyTool, checkTool, scoreTool, healthTool];
}
