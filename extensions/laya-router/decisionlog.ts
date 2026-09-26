import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "./types.ts";

export interface DecisionLogRecord {
	ts: string;
	prompt: string;
	outcome: "switch" | "hold" | "gate" | "error" | "manual";
	bucket: string;
	route?: string;
	confidence?: number;
	reason?: string;
	probabilities?: Record<string, number>;
}

export function decisionLogPath(cfg: RouterConfig): string {
	return cfg.routing?.decisionLogPath ?? join(getAgentDir(), "laya-router-decisions.jsonl");
}

const MAX_LOG_BYTES = 512 * 1024;

function trimLog(p: string): void {
	try {
		if ((statSync(p).size ?? 0) <= MAX_LOG_BYTES) return;
		const keep = readFileSync(p, "utf-8");
		const cut = keep.slice(Math.max(0, keep.length - MAX_LOG_BYTES / 2));
		const nl = cut.indexOf("\n");
		renameSync(p, p + ".1");
		writeFileSync(p, nl >= 0 ? cut.slice(nl + 1) : cut);
	} catch {}
}

export function appendDecision(cfg: RouterConfig, rec: DecisionLogRecord): void {
	if (cfg.routing?.decisionLog === false) return;
	try {
		const p = decisionLogPath(cfg);
		mkdirSync(dirname(p), { recursive: true });
		trimLog(p);
		appendFileSync(p, JSON.stringify(rec) + "\n");
	} catch {
		// logging must never break routing
	}
}

export function tailDecisions(cfg: RouterConfig, n = 5): DecisionLogRecord[] {
	try {
		const lines = readFileSync(decisionLogPath(cfg), "utf-8").split("\n").filter((l) => l.trim());
		const out: DecisionLogRecord[] = [];
		for (const l of lines.slice(-n)) {
			try {
				out.push(JSON.parse(l) as DecisionLogRecord);
			} catch {}
		}
		return out;
	} catch {
		return [];
	}
}

export function fmtProbs(probs?: Record<string, number>): string {
	if (!probs) return "";
	return Object.entries(probs)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}=${v.toFixed(3)}`)
		.join(" ");
}
