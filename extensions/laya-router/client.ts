import { DEFAULTS, type RouterConfig } from "./types.ts";

export class LayaError extends Error {}

function combineSignals(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return external ? AbortSignal.any([external, timeout]) : timeout;
}

/** Distinguish user abort from timeout — an AbortError caused by an external signal is not "timed out". */
function toFetchError(err: unknown, external: AbortSignal | undefined, timeoutMs: number, serveUrl: string): LayaError {
	if (err instanceof Error && err.name === "AbortError" && external?.aborted) {
		throw err;
	}
	if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
		return new LayaError(`laya-serve request timed out after ${timeoutMs}ms (${serveUrl})`);
	}
	return new LayaError(`laya-serve unreachable at ${serveUrl}: ${err instanceof Error ? err.message : String(err)}`);
}

/** POST /v1/systemone with a typed questions payload. */
export async function layaAsk<T = unknown>(
	cfg: RouterConfig,
	body: { state: string; questions: Record<string, unknown> },
	signal?: AbortSignal,
): Promise<T> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
	let res: Response;
	try {
		res = await fetch(`${cfg.serveUrl}/v1/systemone`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: cfg.model ?? DEFAULTS.model, ...body }),
			signal: combineSignals(signal, cfg.timeoutMs ?? DEFAULTS.timeoutMs),
		});
	} catch (err) {
		throw toFetchError(err, signal, cfg.timeoutMs ?? DEFAULTS.timeoutMs, cfg.serveUrl);
	}
	const text = await res.text();
	if (!res.ok) throw new LayaError(`laya-serve ${res.status}: ${text.slice(0, 400)}`);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new LayaError(`laya-serve returned non-JSON body: ${text.slice(0, 200)}`);
	}
}

export async function layaHealth(cfg: RouterConfig, signal?: AbortSignal): Promise<string> {
	let res: Response;
	try {
		res = await fetch(`${cfg.serveUrl}/health`, { signal: combineSignals(signal, DEFAULTS.healthTimeoutMs) });
	} catch (err) {
		throw toFetchError(err, signal, DEFAULTS.healthTimeoutMs, cfg.serveUrl);
	}
	return `${res.status}: ${await res.text()}`;
}

export function compact(value: unknown, max = 4000): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max)}\n... truncated ...` : text;
}
