import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULTS, type LoadedConfig, type RouterConfig } from "./types.ts";

export class ConfigError extends Error {}

function stripJsonComments(text: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (inString) {
			if (c === "\\") {
				out += c + (text[i + 1] ?? "");
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			out += c;
			i++;
			continue;
		}
		if (c === '"') inString = true;
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function parseFile(p: string): Partial<RouterConfig> {
	let raw: string;
	try {
		raw = readFileSync(p, "utf-8");
	} catch (err) {
		throw new ConfigError(`${p}: ${err instanceof Error ? err.message : String(err)}`);
	}
	let parsed: Partial<RouterConfig>;
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch (err) {
		throw new ConfigError(`${p}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConfigError(`${p}: expected a JSON object`);
	}
	return parsed;
}

function merge(base: Partial<RouterConfig>, layer: Partial<RouterConfig>): Partial<RouterConfig> {
	return {
		...base,
		...layer,
		routing: { ...(base.routing ?? {}), ...(layer.routing ?? {}) },
		routes: { ...(base.routes ?? {}), ...(layer.routes ?? {}) },
	};
}

function applyEnv(cfg: Partial<RouterConfig>): Partial<RouterConfig> {
	const out = { ...cfg };
	if (process.env.LAYA_SERVE_URL) out.serveUrl = process.env.LAYA_SERVE_URL;
	if (process.env.LAYA_API_KEY) out.apiKey = process.env.LAYA_API_KEY;
	return out;
}

export function validate(cfg: Partial<RouterConfig>): RouterConfig {
	if (!cfg.serveUrl || typeof cfg.serveUrl !== "string") {
		throw new ConfigError("router.json must define \"serveUrl\" (laya-serve base URL)");
	}
	if (!cfg.routes || typeof cfg.routes !== "object" || Object.keys(cfg.routes).length === 0) {
		throw new ConfigError("router.json must define at least one entry in \"routes\"");
	}
	for (const [name, r] of Object.entries(cfg.routes)) {
		if (!r?.provider || !r?.model) {
			throw new ConfigError(`route "${name}" must define "provider" and "model"`);
		}
		if (!r.description) {
			throw new ConfigError(`route "${name}" must define "description" (used as classification criteria)`);
		}
	}
	if (cfg.defaultRoute && !cfg.routes[cfg.defaultRoute]) {
		throw new ConfigError(`"defaultRoute" is "${cfg.defaultRoute}" but no such route exists`);
	}
	return { ...cfg, serveUrl: cfg.serveUrl.replace(/\/+$/, "") } as RouterConfig;
}

export function configPaths(cwd: string): string[] {
	return [join(getAgentDir(), "router.json"), join(cwd, CONFIG_DIR_NAME, "router.json")];
}

/** Load merged config (project overrides global, env overrides both). Throws ConfigError on broken files. */
export function loadConfig(cwd: string): LoadedConfig {
	let merged: Partial<RouterConfig> = {};
	const loaded: string[] = [];
	for (const p of configPaths(cwd)) {
		if (!existsSync(p)) continue;
		merged = merge(merged, parseFile(p));
		loaded.push(p);
	}
	if (loaded.length === 0) return { config: undefined, paths: [] };
	const cfg = validate(applyEnv(merged));
	return { config: cfg, paths: loaded };
}

export function maxPromptChars(cfg: RouterConfig): number {
	return cfg.routing?.maxPromptChars ?? DEFAULTS.maxPromptChars;
}

export { DEFAULTS };
