import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, configPaths, loadConfig, validate } from "../extensions/laya-router/config.ts";

const VALID = {
	serveUrl: "http://host:8000/",
	routes: {
		quick: { provider: "openai", model: "gpt-mini", description: "simple stuff" },
		reasoning: { provider: "local", model: "big", description: "hard stuff", thinkingLevel: "high" },
	},
	defaultRoute: "quick",
};

function writeConfig(dir: string, name: string, body: unknown): string {
	const p = join(dir, name);
	writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
	return p;
}

let agentDir: string;
let cwd: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "laya-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "laya-cwd-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	for (const k of ["PI_CODING_AGENT_DIR", "LAYA_SERVE_URL", "LAYA_API_KEY"]) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("validate", () => {
	test("accepts a valid config and strips trailing slashes from serveUrl", () => {
		const cfg = validate(structuredClone(VALID));
		expect(cfg.serveUrl).toBe("http://host:8000");
		expect(cfg.routes.reasoning?.thinkingLevel).toBe("high");
	});

	test("rejects missing serveUrl", () => {
		const { serveUrl, ...rest } = structuredClone(VALID);
		expect(() => validate(rest)).toThrow(ConfigError);
		expect(() => validate(rest)).toThrow(/serveUrl/);
	});

	test("rejects empty routes", () => {
		expect(() => validate({ serveUrl: "http://x", routes: {} })).toThrow(/at least one/);
		expect(() => validate({ serveUrl: "http://x" } as never)).toThrow(/at least one/);
	});

	test("rejects route without provider or model", () => {
		expect(() =>
			validate({ serveUrl: "http://x", routes: { a: { provider: "p", description: "d" } as never } }),
		).toThrow(/route "a".*provider/);
	});

	test("rejects route without description", () => {
		expect(() =>
			validate({ serveUrl: "http://x", routes: { a: { provider: "p", model: "m" } as never } }),
		).toThrow(/description/);
	});

	test("rejects defaultRoute pointing at a missing route", () => {
		expect(() => validate({ ...structuredClone(VALID), defaultRoute: "nope" })).toThrow(/defaultRoute/);
	});
});

describe("loadConfig", () => {
	test("returns undefined config when no files exist", () => {
		const { config, paths } = loadConfig(cwd);
		expect(config).toBeUndefined();
		expect(paths).toEqual([]);
	});

	test("loads a single global config", () => {
		writeConfig(agentDir, "router.json", VALID);
		const { config, paths } = loadConfig(cwd);
		expect(config?.serveUrl).toBe("http://host:8000");
		expect(paths).toEqual([join(agentDir, "router.json")]);
		expect(configPaths(cwd)).toEqual([join(agentDir, "router.json"), join(cwd, ".pi", "router.json")]);
	});

	test("project config overrides global, keys merge", () => {
		writeConfig(agentDir, "router.json", VALID);
		writeConfig(join(cwd, ".pi"), "router.json", {
			minConfidence: 0.9,
			routes: { extra: { provider: "p", model: "m", description: "d" } },
		});
		const { config, paths } = loadConfig(cwd);
		expect(paths).toHaveLength(2);
		expect(config?.minConfidence).toBe(0.9);
		expect(Object.keys(config?.routes ?? {}).sort()).toEqual(["extra", "quick", "reasoning"]);
	});

	test("env overrides files", () => {
		writeConfig(agentDir, "router.json", VALID);
		process.env.LAYA_SERVE_URL = "http://env-host:9999";
		process.env.LAYA_API_KEY = "sk-env";
		const { config } = loadConfig(cwd);
		expect(config?.serveUrl).toBe("http://env-host:9999");
		expect(config?.apiKey).toBe("sk-env");
	});

	test("supports JSONC comments", () => {
		writeConfig(
			agentDir,
			"router.json",
			`{
				// line comment
				"serveUrl": "http://x:1", /* block comment */
				"url_like": "not//a//comment",
				"routes": { "a": { "provider": "p", "model": "m", "description": "has // slashes" } }
			}`,
		);
		const { config } = loadConfig(cwd);
		expect(config?.serveUrl).toBe("http://x:1");
		expect(config?.routes.a?.description).toBe("has // slashes");
	});

	test("invalid JSON throws ConfigError with path", () => {
		const p = writeConfig(agentDir, "router.json", "{ broken");
		expect(() => loadConfig(cwd)).toThrow(ConfigError);
		expect(() => loadConfig(cwd)).toThrow(p);
	});

	test("top-level array throws", () => {
		writeConfig(agentDir, "router.json", "[1,2]");
		expect(() => loadConfig(cwd)).toThrow(/expected a JSON object/);
	});
});
