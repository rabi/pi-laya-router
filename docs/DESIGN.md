# pi-laya-router — Design Document

Status: implemented (v0.1). This document captures the architecture, the key
design decisions with their rationale and rejected alternatives, and the
invariants the tests protect. It is the reference for future changes; where it
disagrees with code, the code wins and this file is stale — fix it.

## 1. Problem

Pi sessions ride one model for their lifetime. Real sessions mix work types
with wildly different per-token costs: a lookup needs a cheap model, a
cross-file debugging hunt needs an expensive one. Manually switching models
per prompt is friction; auto-switching with an LLM-as-classifier costs a full
inference before every answer — the routing decision can cost more than the
answer.

**Goal:** pick the right route (model + thinking level) per prompt at
negligible cost and latency, never make a wrong switch expensive, and keep
the human in control (pin, reroute, inspectable decisions).

**Non-goals:** multi-turn planning, quality ranking of models, failover,
load balancing.

## 2. Architecture

```
prompt ──► classifyState ──► laya-serve ──► decision ──► apply
           (code strip,      (/v1/systemone,  (bucket +    (setModel,
            prose tail)       one forward       reason)      setThinking,
                                              pass)          maybe compact)
```

| Module | Responsibility |
|---|---|
| `laya-router.ts` | pi extension entry: event wiring (`session_start`, `before_agent_start`, `session_before_compact`, `session_compact`), command registration |
| `types.ts` | Config/Decision interfaces, defaults, `calibratedSwitchDefaults(n)` |
| `config.ts` | JSONC load, per-key merge, env override, validation with actionable errors |
| `client.ts` | HTTP to laya-serve (`/v1/systemone`, `/health`), signal+timeout combining, typed errors |
| `classifier.ts` | prompt → state preprocessing; `classify()` (choice question) and `scoreRoutes()` (score question) |
| `router.ts` | `RouterState`: modes, gates, hysteresis, floors, apply/switch semantics, compaction trigger |
| `summarizer.ts` | cheap-model transcript digest used by pi's native compaction |
| `decisionlog.ts` | JSONL audit log of every decision (fail-safe, self-trimming) |
| `commands.ts` | `/laya-router` subcommands |

### Request/response flow (mode = intent, the default)

1. `before_agent_start` → `RouterState.route(prompt)`.
2. Guards in order: no config → skip; pinned → hold; sticky+locked → hold;
   `minSwitchChars` small-signal gate (incumbent exists and prose signal is
   tiny) → hold, no network call.
3. `scoreRoutes`: one `score`-type question per route over the full route
   table → probability map `{bucket: p}`.
4. Decision pipeline (`decideByMargin`), in strict order:
   1. **floor eligibility** — a route whose own score is below its `minScore`
      is removed from argmax; `rawBest` (unfloored argmax) is remembered for
      the log;
   2. **minAbsolute** — best eligible score below it → keep incumbent (or
      defaultRoute), `gated`;
   3. **margin hysteresis** — incumbent eligible and challenger within
      `minMargin` → keep incumbent;
   4. else take the best eligible route; if that differs from `rawBest`,
      mark `gated` and name the floored route in `reason`.
5. `apply()`: switch model (skipped when already on target model), set/restore
   thinking level, trigger compaction when warranted. Tri-state result:
   `true` switched / `false` held / `undefined` failed.
6. Append the decision to the JSONL log; expose via `/laya-router status`.

## 3. Key decisions

### D1 — Classifier is an external single-pass model (laya-serve), not an LLM

The router asks a System-1 model (laya-serve, one forward pass, typed
choice/score/noul heads) instead of prompting an LLM to classify.

- **Why:** routing must be cheaper and faster than the cheapest answer it
  selects. A forward pass is milliseconds; an LLM classification is a second
  agent turn — the regression the whole project exists to avoid.
- **Rejected:** LLM-as-judge (cost/latency), embedding similarity (no
  ordering → can't drive margin gates), heuristics/keywords (brittle, doesn't
  generalize across route tables).
- **Consequence:** routing quality is bounded by laya; the gates (D4–D7) exist
  precisely because laya's output is a noisy prior, not a verdict.

### D2 — Three routing modes; intent-only is the default

- `classify` (`switchPolicy: false`): switch on any classification change.
- `sticky` (`stickySession: true`): first prompt picks, session rides it.
- `intent` (default): re-score every prompt, switch only on margin (D4).

- **Why:** classify-every-prompt thrashes on near-uniform scores; sticky
  wastes the classifier and strands mid-session topic changes. Intent-only
  keeps the classifier cheap-but-live and pays the switch cost only when the
  evidence is strong.
- **Rejected:** time-decayed switching, per-route cooldowns (extra state, no
  evidence they beat a margin).

### D3 — Session pin overrides everything

`/laya-router pin <route|provider/model>` holds a model until `unpin`. Bare
`provider/model` targets are validated against pi's model registry so pins
work for models outside the route table. `reroute` releases pin + lock +
incumbent (one escape hatch for everything).

- **Why:** the user must always be able to veto the router without disabling
  it; and the pin must be visible in `lastDecision` on every skipped prompt.
- **Semantics chosen:** pin survives `reload` (a config edit shouldn't
  silently override an explicit human choice); cleared on session start
  (a pin is a session-scoped statement).

### D4 — Switch gates calibrated to route count N, not fixed constants

Defaults: `minMargin = clamp(0.25/N, 0.03…0.15)`, `minAbsolute = clamp(1/N +
0.03, 0.2…0.4)`.

- **Why (measured):** laya's N-way distributions sit near the uniform prior
  1/N. A fixed `minMargin: 0.15` on a 4-route table exceeds any real gap —
  the incumbent gets pinned forever; a fixed `minAbsolute: 0.3` on a 2-route
  table rejects clear winners. Calibrating to the prior makes the defaults
  sane for any table size; explicit `switchPolicy` values always override.
- **Rejected:** fixed universal constants (fail in both directions depending
  on N), learned/adaptive thresholds (needs training data we don't have).

### D5 — Per-route `minScore` floor; fallback is next-best eligible, NOT defaultRoute

A route with `minScore` is eligible only when its own score clears the floor
(intent mode: its probability; classify mode: `answer_confidence`). Below
the floor it is dropped from argmax and the best **eligible** route wins.
DefaultRoute fires only when no route is eligible. An incumbent sitting below
its own floor loses margin protection (cost outweighs hysteresis). When
nothing is eligible, the incumbent is kept and the decision is `gated`.

- **Why:** route tables mix costs by 10–100×. Argmax alone happily hands a
  0.31-score prompt to the most expensive model. The floor expresses "this
  model only on clear intent" per route, without starving cheap routes (the
  floor is per-route, not global).
- **Why next-best, not default (explicit user decision):** falling back to
  defaultRoute on every floor miss throws away the classifier's remaining
  signal — the second-best route's score is real evidence; defaultRoute is a
  constant. The global `minAbsolute`/`minConfidence` gate still decides when
  the remaining evidence is too weak, so defaultRoute appears exactly when
  the gates already prescribe it.
- **Invariants (test-protected):** the floor is an additional constraint,
  never a bypass of the global gates (see D6); eligibility uses each route's
  own floor, so one expensive route can't gate the others.

### D6 — `minConfidence` is a global no-misroute gate that demotions cannot cross

In classify mode the next-best scan only accepts candidates that clear both
the global `minConfidence` and the candidate's own floor; otherwise the
decision falls to defaultRoute keeping the original choice's confidence.

- **Why:** a real bug in the first floor implementation: review (floor 0.6,
  choice confidence 0.55) demoted to quick at 0.4 under `minConfidence: 0.5`
  — a low-confidence misroute the gate exists to prevent, entered through
  the back door. Rule: a per-route floor can only *remove* options, never
  *grant* an option the global gate rejects.
- **Rejected:** per-route `minConfidence` overrides (two knobs for one job);
  re-normalizing probabilities after demotion (fabricates confidence).

### D7 — Small-signal gate (`minSwitchChars`, default 40): hold incumbent, skip the call

If the classifiable signal (prose after code stripping — what laya actually
sees) is under N chars and an incumbent exists, keep it and make **no network
call**. The first prompt always routes.

- **Why:** "yes, do it" and 5KB-log-paste-plus-"analyze this" leave a few
  words of prose — near-noise scores that can still flip models through the
  margin gate. Holding is also correct by topic-continuity: a two-word
  followup is about the previous turn, which the incumbent already fits.
  Skipping the call makes the gate free.
- **Rejected:** always calling and gating on score floors (costs a round trip
  and laya's near-uniform noise still leaks through).

### D8 — Prompt preprocessing: strip code, keep prose tail

`classifyState`: if over the char limit or containing fences, drop fenced
blocks and code-dense lines, keep the prose, retain the tail up to the limit.

- **Why (measured):** laya's forward pass drowns the trailing question under
  code — ~700 chars of code + "review this" scored identically to the code
  alone. The routing intent lives in the prose, and in long pastes the ask is
  at the end.
- **Consequence:** the same preprocessing feeds both modes, so scores and
  choices see one consistent view — and D7's gate can measure exactly what
  laya would see.

### D9 — Model switch triggers pi's *native* compaction, intercepted for a cheap summariser

On a real switch, the plugin calls `ctx.compact()`; `session_before_compact`
intercepts and writes the summary with a cheap model. An earlier design
injected a digest message instead — removed in favor of native compaction.

- **Why native:** pi owns the cut point, retention, token accounting, and the
  session's compaction invariants. Digest injection duplicated all of that
  badly (stale digests, double context, lost messages). Intercept-and-replace
  is one seam; fallback-to-default is free (return `undefined`).
- **Why compact on switch at all:** the new model's prompt cache is cold no
  matter what — a compacted transcript strictly beats replaying full raw
  history through a cold cache.
- **Trigger gate mirrors pi's own no-op condition** (decision, after a real
  bug): pi throws "Nothing to compact" unless the span *since the last
  compaction* has ≥ 2 user turns and ≥ `keepRecentTokens` message tokens.
  Usage-based checks are wrong — `getContextUsage().tokens` includes system
  prompt + tool schemas (20k+ alone) while pi counts session messages only.
  We mirror `prepareCompaction()` over the session projection instead.
- **Summariser failure is never fatal:** caught, warned, pi default compaction
  proceeds. Known failure mode found in practice: thinking models spend the
  `maxTokens` budget on reasoning blocks and return an empty digest — hence
  "keep summariser `thinkingLevel: off`" in docs, and `stopReason: length`
  now self-diagnoses the token budget in the error.
- **Rejected:** summarising with the current (expensive) model (the point is
  to not pay for it), separate summariser agent/turn, custom memory system.

### D10 — Fail-safe everywhere: routing must never break a session

- Every failure path degrades to the pre-router behavior: config invalid →
  silent no-op (+one warning); laya unreachable/timeout → prompt routes
  unmodified (warning); `apply` failure (model missing, no API key) → tri-state
  returns `undefined`, incumbent bucket NOT updated, no compaction fired,
  next prompt retries; summariser fails → pi default compaction; decision-log
  write fails → swallowed.
- **Why:** an optional convenience that can break the agent loop is not
  optional anymore. The bucket/locked state is only advanced on confirmed
  success, so failures don't corrupt routing memory.

### D11 — Decision log: plain JSONL under the agent dir, append-only, fail-safe

Every decision (prompt excerpt, outcome, bucket, route, confidence, reason,
full probability map) appends to `~/.pi/agent/laya-router-decisions.jsonl`
(path configurable; `decisionLog: false` opt-out; trimmed at 512 KB keeping
the newest half).

- **Why:** routing quality against a noisy classifier is only tunable with a
  corpus of actual decisions — the margin/floor calibration (D4, D5) came from
  exactly this data. JSONL survives crashes, is grep/tail-able, needs no
  service. Last-5 surfaced in `/laya-router status` for zero-friction
  inspection.
- **Rejected:** SQLite (dependency for an append-only audit), pi's own session
  log (different lifecycle; decisions outlive sessions), in-memory ring
  (dies with the process — the corpus is the point).

### D12 — Config layering: `env > <cwd>/.pi/router.json > ~/.pi/agent/router.json`, JSONC, validated

Deep merge with per-entry merge for `routes`/`routing`; `//` and `/* */`
comments allowed; validation errors name the file, key, and fix.

- **Why:** global defaults with per-project override is the pi convention;
  comments make the file self-documenting (the shipped example is a commented
  file); strict validation at load (e.g. `minScore` must be in [0,1]) beats
  silent misbehavior at decision time — a typo'd floor silently disabling an
  expensive-route guard is exactly the failure validation must catch.
- **Rejected:** TOML/YAML (JSON is what pi configs are), CLI flags (state
  must survive reload), UI-only configuration (no headless use).

### D13 — State lifetime: bucket survives reload, pin survives reload, everything else dies with the session

`reload` re-reads config but keeps `currentBucket` (a config edit must not
silently re-route a working session), keeps the pin (explicit human choice,
D3), keeps hysteresis memory. `resetSession` clears all of it; `session_start`
calls it. `reroute` is the manual "forget the incumbent" button.

- **Consequence handled:** after `reload`, the incumbent bucket may no longer
  exist in routes. The decision pipeline must not fake a margin for an
  unscored incumbent (it logs `incumbent "x" unscored (route removed?)`), and
  an unscored incumbent gets no margin protection.

## 4. Module invariants (what the tests pin down)

- `route()` returns `undefined` (no switch, no log) on: no config, pin active,
  sticky-locked, small-signal hold, unclassifiable prompt, laya error, apply
  failure. Only a `RouteResult` means the model may have changed.
- Floor demotion sets `gated: true` and names the demoted route in `reason`
  (log line: `…; "review" below its minScore floor`).
- `hasCompactableHistory()` matches pi's real no-op condition (validated
  against 8 real session files); compaction never fires unguarded.
- `apply()` is tri-state and callers distinguish `false` (held — no compaction
  beyond pi's own) from `undefined` (failed — don't touch state).
- Summariser: thinking-off recommended; empty digest reports the cause
  (token budget vs stopReason) rather than guessing.
- Decision-log corruption (torn last line) must not break `tailDecisions`.

## 5. Known limitations

- **≤ ~5 routes.** laya's classification quality degrades past that; the
  calibrated defaults (D4) assume the near-uniform prior, which weakens with
  more labels. Split route tables per project rather than growing one.
- **`answer_confidence` is not P(correct).** It is probability mass on the
  chosen label from a single forward pass; floors and gates are tuned to its
  empirical distribution, not to any guarantee. Re-calibrate thresholds if
  the laya checkpoint changes.
- **Switch cost is compaction, not classification.** Each accepted switch
  pays a summariser call and a cold cache. Margin hysteresis bounds switch
  frequency but not severity — keep expensive routes behind `minScore` and
  change route tables rarely.
- **Single-turn topic changes** ("actually let's do X instead") read as small
  signals and hold the incumbent until the prose crosses `minSwitchChars`.
  Accept `minSwitchChars: 0` (per config, not per session) if that bothers a
  workflow more than thrash; `/laya-router pin` is the per-session answer.
- **External dependency.** laya-serve down = no routing (by design, D10). No
  local fallback classifier exists.

## 6. Testing strategy

`bun test tests/` — unit + integration without envtest/docker:

- HTTP boundary stubbed by replacing `globalThis.fetch` with canned
  `/v1/systemone` responses (`stubScores`, `stubAnswer`) — exercises real
  client/classifier code paths, no network.
- `mockCtx` provides pi's `ExtensionContext` surface (modelRegistry,
  sessionManager projection, compact spy) — the same seams the extension
  uses in production.
- Every gate, floor, mode, pin transition, failure path, and log record has a
  named test; regression tests carry the bug they were born from as a comment
  (see D6's test).
