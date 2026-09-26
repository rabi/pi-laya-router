# pi-laya-router

Laya decision tools and prompt-based model routing for [pi](https://github.com/earendil-works/pi). All inference runs on a remote [laya-serve](https://pypi.org/project/laya-serve/) instance (Jev-compatible `POST /v1/systemone`); the plugin itself has no runtime dependencies beyond what pi provides.

## What you get

Decision tools (single forward pass, ~1 s):

| Tool | Purpose |
|---|---|
| `laya_ask` | Batch of typed questions (`choice` / `score` / `noul`) over one state |
| `laya_classify` | Classify a state into categories |
| `laya_check` | One yes/no question, returns P(true) |
| `laya_score` | Rate on an ordered 2-10 scale |
| `laya_health` | Remote server health, no inference |

Automatic model routing (on by default when `router.json` exists): before each agent run the user prompt is classified into one of your route buckets and pi switches the active model via `pi.setModel()`. Set `routing.enabled: false` or `/laya-router off` to disable. Manual `/model` choice is overridden per turn while routing is on.

### Routing strategies

Pick one — they share the same laya classifier and confidence gate:

| Strategy | Config | Behavior |
|---|---|---|
| Intent-only (default) | — | Every prompt is scored, but the model switches only when a challenger beats the incumbent's score by `minMargin` (default 0.15). Prompts that match nothing (`< minAbsolute`) keep the incumbent. Tune with `"switchPolicy": { "minMargin": ..., "minAbsolute": ... }`. |
| Session lock | `"stickySession": true` | First prompt picks the model; the rest of the session rides it. Maximum prompt-cache hits. Escape hatch: `/laya-router reroute`. |
| Classify-every-prompt | `"switchPolicy": false` | Every prompt re-routes, switching on any classification change — no margin gate. Maximum misroute surface, cache thrash on flip-flops. |

`stickySession` takes precedence when both are set. Thin margins are exactly where laya's near-chance signal is worst, so the intent gate is the safer default.

**Small-signal gate (all strategies).** If the classifiable signal — the prose left after code stripping, i.e. what laya would actually see — is under `minSwitchChars` (default 40), the incumbent model is kept and no laya call is made at all. Tiny followups ("yes, do it") and data-heavy pastes (5KB of logs + "analyze this") are near-noise for switching. The first prompt always routes; `"minSwitchChars": 0` disables the gate.

### Switch summarisation (optional, any strategy)

`routing.summarizer` names a cheap model (provider/model, auth resolved through pi's registry). When a routing decision actually changes the model — the new model's prompt cache is cold anyway — the plugin triggers pi's native session compaction and intercepts it to write the summary with the cheap model instead of the (potentially expensive) current one. The compaction only fires once the session is large enough to have anything to compact (≥ 20k context tokens); summariser failures fall back to pi's default compaction. `maxInputChars` (default 60000) caps the transcript fed to the cheap model (newest content kept).

## Install

```bash
pi install /path/to/pi-laya-router      # or npm/git source once published
```

## Configuration

Copy `router.json.example` to one of (project overrides global):

- `~/.pi/agent/router.json`
- `<cwd>/.pi/router.json`

Files are merged per-key (`routes`/`routing` merged per-entry), accept `//` and `/* */` comments, and are validated on load with actionable errors. Env overrides win over both files: `LAYA_SERVE_URL`, `LAYA_API_KEY`.

```jsonc
{
  "serveUrl": "http://10.37.137.29:8000",  // laya-serve base URL
  "apiKey": "",                             // optional Bearer token
  "model": "laya",                          // accepted laya-serve model name
  "timeoutMs": 10000,
  "minConfidence": 0.5,                     // below this -> defaultRoute (no misroute)
  "defaultRoute": "quick",
  "routing": { "enabled": true, "maxPromptChars": 8000 },
  "routes": {
    "reasoning": { "provider": "anthropic", "model": "claude-...", "description": "Deep reasoning, math, architecture", "thinkingLevel": "high" },
    "code":      { "provider": "openai",    "model": "gpt-...",    "description": "Writing or refactoring code" },
    "quick":     { "provider": "openai",    "model": "gpt-mini",   "description": "Simple questions, lookups" }
  }
}
```

`description` per route is the classification criteria — keep them short and mutually distinct; Laya degrades past ~5 buckets.

## Commands

- `/laya-router` — status (routing on/off, serve URL, loaded config paths)
- `/laya-router on|off` — toggle auto-routing
- `/laya-router reload` — re-read router.json without restarting pi
- `/laya-router routes` — routing table + last decision
- `/laya-router reroute` — drop the session lock; next prompt re-classifies (sticky mode)
- `/laya-router test <text>` — classify without switching (shows confidence and whether the default-route gate fired)
- `/laya-router health` — ping remote laya-serve

## Layout

```
extensions/
  laya-router.ts          # thin entry: wires events, tools, command
  laya-router/
    types.ts              # shared interfaces + defaults
    config.ts             # JSONC load, deep merge, env override, validation
    client.ts             # /v1/systemone + /health HTTP client (abort-aware)
    classifier.ts         # prompt -> route bucket via laya choice question (+ scoreRoutes for switch policy)
    summarizer.ts         # cheap-model transcript summary for model switches
    router.ts             # RouterState: sticky/intent routing, small-signal gate, compact trigger
    tools.ts              # the five decision tools
    commands.ts           # /laya-router subcommands
```

Adding a new decision tool = one `defineTool` in `tools.ts`; adding a route bucket = one entry in `routes`. No other file changes.

## Caveats

- Laya confidence is a concentration statistic over the option distribution, **not** P(answer correct). Use `minConfidence` as a sanity gate, not a correctness guarantee.
- The zero-shot English checkpoint is weak on fine-grained taxonomies (near chance on some published benchmarks). Validate your buckets with `/laya-router test` before trusting `routing.enabled`.
- If the sidecar is down, routing is skipped with a warning and the current model is kept.
