# dsh-working-activity-llm

A live **working chip** for DeepSeek Harness 0.2.x: what the agent is running, and — new in this fork — **what it is actually trying to accomplish**, asked of a small/fast model.

```
✨ Investigating why the Snowflake connection is failing…         3
```

The text is an LLM inference over the live turn. The `3` is the turn's tool count. The row sits above the composer, in the same dock slot the upstream plugin uses.

> **This is a fork.** Upstream: [ccch1mneyyy/working-activity](https://github.com/ccch1mneyyy/working-activity) (BSD-3-Clause, `dsh-working-activity`). This fork exists because upstream targets the DSH `0.1.x` line, where every one of its declared peer ranges evaluates `false` against the `0.2.0-rc.2` host this desktop ships. See [What changed](#what-changed-vs-upstream).

---

## The two layers, and why both exist

| Layer | Source | Answers | Latency |
|---|---|---|---|
| **Heuristic line** (upstream) | local fold of session events | *what is running* — `跑个命令 npm test · 12s`, `Read src/index.ts · 2s` | instant, always |
| **Semantic summary** (this fork) | one auxiliary model call | *what the agent is trying to do* — `✨ Investigating why the Snowflake connection is failing…` | first answer ~1–3 s, then refreshes |

The chip always shows something. The heuristic line paints first and stays the fallback: until the first summary lands, whenever the model is slow or unreachable, and for every settled turn (where it shows the upstream done summary, `搞定 ✓ · 4 工具 · 想12s 干11s`).

### Architecture

```
agent events / tool calls ──► SemanticActivityClassifier ──► small/fast model
   (session/event,                debounce + interval floor      (ctx.llm.stream)
    agent/assistant-stream)       single in-flight call
                                            │
                                            ▼
                                   SummaryRegistry
                                     │           │
                    session projection│           │own host route
                    (heuristic line,  │           │GET /working-activity-llm/summary
                     phase, tools)    ▼           ▼      ?sessionId=…
                                   ┌───────────────────────┐
                                   │  conversation.input.dock │
                                   │  chip row above composer │
                                   └───────────────────────┘
```

Two transports on purpose. The `workingActivity` **session projection** carries the phase, the tool count and the heuristic line — it is the supported channel for values derived from the session log, and it is what upstream already ships. The **summary** rides its own small route instead, because a projection only re-publishes when a *committed session event* folds and its recomputed view differs by `Object.is`. A classifier answer arrives between events — usually while one long tool is running and nothing else has been committed — so an event-driven channel would hold the new chip hostage until that tool finished. The route gives the chip its own cadence without writing anything to the session log.

The host half also serves the settings page: `GET /working-activity-llm/models` lists the configured provider routes and their models for the pickers on the plugin's row in the Plugins page, and the route/icon keys are declared as volatile config fields, so a value saved there reaches the very next call without a remount.

### Verified behaviour, measured on a live `0.2.0-rc.2` host

Everything below was observed on a real boot, not inferred from types. The numbers come from a scripted multi-step debugging task:

| Observation | Result |
|---|---|
| Summaries produced | **47 / 47 calls**, zero failures on the configured route |
| Quality | `Fixing the database connection after a password rotation`, `Investigating why the database module import is failing due to shadowing`, `Refactoring the app to use environment-based database configuration` |
| Heuristic line | Unchanged from upstream (`⏵ Running the exact printf probe command · Executing printf … · 0ms`, then `Done and dusted · 1 tool · thought 3s worked 29ms · 🔥 13.7k`) |
| Default route, thinking not pinned | **3 of 6 calls failed** with `max-tokens` and no text — the reason `semanticMaxOutputTokens` is 512 and `semanticReasoningEffort` exists |
| Passing `sessionId` | **Required.** Omitting it makes `opencode-go` answer `400 MissingSessionID: Request is missing x-opencode-session`. The provider's own documentation lists DeepSeek Harness as a client whose session header is missing on some model paths |
| `stop: ['\n']` | Unsupported: `llm-pi-ai does not support GenerateOptions.stop`, so the one-line contract is enforced on the reply instead |
| A reply opening with a code fence | Cleaned and served (the phrase on the next line survives) |
| Truncated (`max-tokens`) reply | Salvaged when it contained any text, and only then reported as a failure when it contained none |

> **On the desktop, the page origin is `dsh-app://app` — and that is fine.** The
> GUI is *not* loaded from `http://127.0.0.1:<port>`; Electron loads it over the
> shell's custom `dsh-app` scheme (registered as a standard/secure/fetch scheme).
> A same-origin `fetch('/working-activity-llm/summary')` therefore becomes
> `dsh-app://app/…`, which the shell **proxies to its authenticated host** —
> deleting `host`, `origin`, `cookie` and `sec-fetch-site` first, then injecting
> the host's own auth cookie. Three consequences worth knowing before you debug
> a "missing" route:
>
> 1. The route is reachable from the page even though nothing listens on the
>    page's origin, so this transport works on desktop and in a browser alike.
> 2. The arriving request has **no `Origin`** and a `Host` that Node sets from
>    the upstream URL — which is why the fence checks the Host and treats an
>    absent `Origin` as acceptable, rather than requiring one.
> 3. Reaching the host with `curl` proves nothing: direct requests carry no auth
>    cookie and are answered `401` before any plugin route is consulted. Verify
>    through the page, or through the debug log.



---

## Installation

```sh
dsh plugin --profile <profile> add dsh-working-activity-llm
```

From a local checkout, add the standalone package directory:

```sh
dsh plugin --profile <profile> add /path/to/dsh-working-activity-llm
```

For the `desktop` profile, use the Electron app's Plugin Manager; that profile cannot be changed by the CLI.

The package is a **self-mounting bundle**: it declares `dsh.bundle.patch` (`cordis.patch.yml`), so the CLI both installs it and appends it to the profile's `dsh.profile.bundles`. At boot the bundle patch inserts its own `working-activity` row — no manual mount. It ships both halves: the node plugin and the browser bundle (`lib/client.js`), which the web client auto-mounts into `conversation.input.dock`. No official source patch, no runtime patch.

**Restart DSH after installing** — a new cordis row is not hot-mounted. Then rebuild the browser half after any `src/client/` change:

```sh
cd /path/to/dsh-working-activity-llm
npm run build:client     # tsdown → lib/client.js
```

While `lib/client.js` is missing, the web host fails loudly at activation (`declares dsh.client but exports no "./client" bundle`), so never delete it without rebuilding.

---

## Configuration

Every key is optional; defaults shown. Override by id in the profile's user layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) — **do not insert a second same-id row**:

```yaml
- id: working-activity
  config:
    semanticMinIntervalMs: 8000
    semanticModel: deepseek-v4.1-flash
```

### Semantic chip

The chip summarizes *what is being worked on*, not which tool ran. It never injects instructions into the primary assistant's system prompt or changes the assistant's reply. When semantic summaries are enabled, a separate auxiliary request receives a bounded activity excerpt solely to produce the chip text. Three rules make that happen:

1. **A call carries a delta, never the whole window.** Every signal (a new user request, a tool starting, a tool *failing*, the model's own output growing by 160 characters) becomes one indexed activity line. A call is armed by the pi-bar cadence — a 1.5 s quiet period, capped at 2.5 s from the start of a burst, floored at one call per `semanticMinIntervalMs` — and only ever asks about lines that were **not yet consumed** by an accepted answer. Re-summarizing the same window was what produced rewordings of one idea instead of progress.
2. **The narration contract is pi-bar's, ported.** The user message is `Prior updates (context only; never copy their phrasing):` + the accepted lines, then `New activity since the last accepted update:` + the unconsumed lines (plus the newest request when the update covers one), then a one-fragment closing instruction. The system message forbids tool/agent mechanics, file paths, identifiers, package versions and markdown; it requires a first word from an allow-list (`Reviewing`, `Investigating`, `Fixing`, …) and bans the tool-narration verbs that used to dominate (`Reading`, `Running`, `Verifying`, `Checking`, …). The constraints are stated **last**, where recency bias helps.
3. **A reworded answer is withheld, not repainted.** The reply is cleaned by the same sanitizer chain pi-bar uses (leaked scaffolding, markdown, identifier/version leaks, dangling prepositions, "with success" suffixes, banned first words). If the cleaned line matches the line already on screen — exactly, or ignoring case, punctuation and spacing, which is what "near-duplicate" means here — it is dropped and the trace records `semantic: "skip"`. The chip holds a true line instead of flickering through "Editing X." / "Editing X" variants. What changed the wording for good, though, is rule 1: a call that carries new evidence has something new to say.

`semanticIcon: ""` removes the default `✨ ` prefix (an empty string is a valid value and is kept, not replaced by the default).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `semantic` | `boolean` | `true` | Master switch. `false` = upstream behaviour, zero model calls, no route. |
| `semanticProvider` | `string` | `''` | Route override. Must be set together with `semanticModel`. |
| `semanticModel` | `string` | `''` | When both are empty (default), the classifier reuses **the route the session itself last requested under** (`session.requestHeader()`), so no extra credentials are needed. |
| `semanticReasoningEffort` | `string` | `''` | Explicit reasoning effort (e.g. `low`). Empty leaves the adapter default. **Set this for a reasoning model** — see the box below. |
| `semanticMaxOutputTokens` | `number` | `512` | Output cap for one call. Must leave room for a reasoning model's hidden thinking. |
| `semanticDebounceMs` | `number` | `1500` | Quiet period after the last activity signal before a call is dispatched. |
| `semanticMaxWaitMs` | `number` | `2500` | Ceiling on that quiet period, measured from the start of a burst: a turn that streams without pause still updates. |
| `semanticMinIntervalMs` | `number` | `2500` | Hard floor between two calls, however busy the turn is. This is the cost knob. |
| `semanticTimeoutMs` | `number` | `6000` | End-to-end deadline for one call. |
| `semanticMaxChars` | `number` | `72` | Maximum accepted summary length. |
| `semanticMaxInputChars` | `number` | `2400` | Maximum framed prompt handed to the model. |
| `semanticIcon` | `string` | `'✨ '` | Prefix rendered in front of the summary. |
| `summaryPollMs` | `number` | `1000` | How often the chip asks the host for a fresh summary **while a turn is live only** (200–10000). Advertised to the browser by the route, so this config actually reaches the client. |

> **Pin the reasoning effort.** A reasoning model's hidden thinking is billed
> against `semanticMaxOutputTokens`. On the default route this was measured
> failing **half the time** (`max-tokens` with no text emitted) until the budget
> was raised and the effort pinned. A classification task gains nothing from deep
> thinking, so `semanticReasoningEffort: low` is both cheaper and more reliable.
> An effort the model does not declare is rejected by the adapter before any
> provider I/O, which is why this is config rather than a default.

```yaml
- id: working-activity
  config:
    semanticProvider: opencode
    semanticModel: gpt-6-luna
    semanticReasoningEffort: low
```

> **Model availability is decided by the kernel's bundled catalog**, not by the
> provider's live one. On a `0.2.0-rc.2` desktop the `opencode-go` route knows
> `gpt-5.6-luna` but not `gpt-6-luna`; the latter is present only under the
> `opencode` route. Naming a model the adapter does not know fails as
> `pi-ai provider "<p>" has no configured model "<m>"` in the debug log. To add a
> route, extend the provider's own config — the classifier needs no changes.

### Editing it live from the Plugins page

Four keys are **live**: `semanticProvider`, `semanticModel`,
`semanticReasoningEffort` and `semanticIcon`. Open the **Plugins** page in the
sidebar, find this plugin's row, and use its **Configure** control: the row page
offers a provider and a model picker (both fed by the models this deployment can
actually call), a reasoning-effort picker for models that declare one, and the
chip's icon text. Saving writes the value into the active profile's patch and
into the running plugin, so the next summary uses the new route — no restart.

- The pickers come from this plugin's own host route,
  `GET /working-activity-llm/models`, which walks the **configured** provider
  routes and asks each one for its models. Unconfigured routes in the adapter's
  catalog are deliberately omitted: choosing one could only fail. A provider
  whose listing fails appears with its error instead of emptying the dropdown,
  and the answer is cached for 60 s.
- Leaving provider and model empty means "reuse the route the session itself
  last requested under", which is the default and needs no extra credentials.
  `semanticReasoningEffort: ""` means "the adapter's own default"; a model that
  declares no reasoning levels hides that control.
- `semanticIcon: ""` is a valid, kept value: the chip is rendered without any
  prefix.
- Everything else in the table below — cadence and budgets — describes the
  classifier built when the plugin mounted and stays restart-bound. The same
  values can always be written in the profile patch instead of the page; the
  page is just a form over that same patch.
- The row page only appears where the deployment can serve it: the plugin must
  be an active entry of the active profile (it is, when installed as a bundle),
  and non-loopback pages are read-only by design — the page then reports the
  fields as unavailable rather than pretending to save.

### Upstream keys (unchanged)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `phrases` | `boolean` | `true` | Playful copy pool; `false` renders plain functional labels. |
| `publish` | `boolean` | `false` | Append `activity/status` session events for log-replaying consumers. **Leave off on 0.2.x** — see [Known limitations](#known-limitations). |
| `tickMs` | `number` | `500` | Status render tick (100–5000). |
| `publishIntervalMs` | `number` | `2000` | Minimum interval between published events while stable (500–30000). |
| `detailLimit` | `number` | `40` | Max displayed detail length (paths/commands/patterns), 8–120. Also bounds what the classifier sees per tool call. |
| `customActions` | `object` | `{}` | Exact tool-name → action-copy pools. |
| `lang`, `frames`, `mode`, `features`, `customPhrases`, `showTokPerSec`, `workRemindAt`, `debugLog` | — | — | As upstream. |

### Diagnostics: `debugLog`

Set `debugLog: true` to trace both layers to `~/.dsh-tui/working-activity-debug.log`:

```json
{"at":1760000000000,"session":"session-…","line":"跑个命令 psql -c 'select 1' · 2s"}
{"at":1760000001500,"session":"session-…","semantic":"summary","revision":1,"text":"Investigating why the Snowflake connection is failing","line":"Investigating why the Snowflake connection is failing"}
{"at":1760000002000,"session":"session-…","semantic":"skip","reason":"near-duplicate","text":"Investigating the Snowflake connection failure"}
{"at":1760000002500,"session":"session-…","semantic":"error","error":"…"}
{"at":1760000003000,"semantic":"settings","entry":"include:working-activity","writable":true,"namespaces":["working-activity","…"],"autoGenerate":false}
{"at":1760000003500,"semantic":"models","providers":[{"id":"opencode","models":12},{"id":"opencode-go","models":9}]}
```

`semantic: "skip"` is the one to look for when the chip seems stuck: the model answered, but the answer said nothing new. `line` is what the chip actually rendered (`text` plus the configured icon), which is what makes an icon question answerable from the log.

The two settings lines answer "why does the Plugins page show nothing?" from a log: `semantic: "settings"` lists the namespaces the host is serving after mount settles (`working-activity` must be in it, and `autoGenerate: false` proves this plugin declared its own page), and `semantic: "models"` records what the dropdown was actually offered — one entry per provider, with the error text when a provider listed nothing.

This is the only way to answer "why did it say THAT" — the chip is derived, never stored.

---

## Privacy, cost, and what leaves the machine

- **What the classifier sends:** the current user request (up to 1200 chars), the activity lines **not yet consumed** by an accepted answer (tool calls with one salient argument fragment each, bounded by `detailLimit`, plus the tail of the model's own output, ≤800 chars), and up to 8 previously accepted lines as context. Framed as prose, whole prompt bounded by `semanticMaxInputChars`.
- **Where it goes:** to the model route the session is already using (or the pair you pin). No third party, no telemetry, no new network destination — this plugin adds **zero** new endpoints or services.
- **What it costs:** one auxiliary completion per `semanticMinIntervalMs` of *actual activity* (not wall-clock while idle). With the defaults that is roughly one short call every ~2.5 s of continuous work — and nothing at all while the turn is quiet, because an empty delta is never worth a call. The call is capped by `semanticMaxOutputTokens` (512) and `semanticTimeoutMs`.
- **What it does NOT do:** it never appends to the session log, never enters the model's derived history, and never shows up in the transcript. It is also invisible to the token meter, which folds usage from the durable log — so **your in-app token/cost display will not include these calls**, though your provider bill will. This is deliberate (a chip update must not spam the log) and is why the cost knob is documented above.
- The host route is read-only, returns only the summary copy for a session the caller already renders, and is fenced like the official `/api` gateway (loopback or configured trusted authority, no cross-site fetch, same-origin when `Origin` is present).

---

## What changed vs upstream

1. **Retargeted to one host line: DSH `0.2.0-rc.2`.** Upstream's peer ranges (`^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.7-rc.2`) all evaluate `false` against this host. Every `@deepseek-ai/dsh-*` peer is now `^0.2.0-rc.2`, `cordis` `^4.0.4`, and each dev dependency is pinned exactly to `0.2.0-rc.2`. Package renamed to `dsh-working-activity-llm` so it cannot collide with the upstream npm package. The row id stays `working-activity`.
2. **Fixed the frozen-externals table.** `tsdown.config.ts` listed `@deepseek-ai/dsh-client-web-react` and `@deepseek-ai/dsh-client-schema-form` — neither exists in the 0.2.0 asar — and omitted `@deepseek-ai/dsh-client-store` and `@deepseek-ai/dsh-client-ui-dockkit`. The real 0.2.0 seed table is exactly nine specifiers, taken from the shell's own `staticModules`. Since the bundle's purity gate asserts against that array, the stale table silently permitted specifiers the runtime cannot resolve. This was the concrete blocker for the browser half.
3. **Added the semantic classifier** (`src/semantic.ts`, `src/llm-summarizer.ts`, `src/summary-registry.ts`, `src/summary-route.ts`), the pi-bar-derived narration contract (`src/narration.ts`), and the client poll (`src/client/summary.ts`), as described above.
4. **Small host fixes for 0.2.x:** the retired `assistant/chunk` log event is now reached through a widened type (it is absent from the 0.2 `SessionEventMap`, so a literal `case` no longer compiles) while replay of old logs keeps working; `feedStreamFrame` returns the events it normalized so a second consumer cannot consume the frame cursor twice; `dsh.client.inject` dropped `dsh-client-ui-slots` (it has no browser half).

## Known limitations

- **Never turn on `publish` on 0.2.x.** `Session.append()` cannot set the `ignorable` envelope marker, and the persistence loader refuses a log containing an unknown non-ignorable type — so a published snapshot can make that session refuse to reopen. Upstream already defaults this off; `src/registration.ts` still patches the host's known-type set, which is functional but unsupported. The Web chip needs none of it.
- **The summary can lag the heuristic line by design.** It is one model call behind reality; `semanticMinIntervalMs` trades freshness for cost. The chip's seconds and the heuristic fallback are always live.
- **A withheld answer is not a stall.** When the model answers with the same action it already showed (only case, punctuation or spacing differ), the chip deliberately keeps the old line. It is a *new* activity line that re-arms the call, so a genuinely quiet stretch looks the same as a reworded one — with `debugLog: true`, `semantic: "skip"` says which of the two it was.
- **Route inheritance needs a first request.** On a brand-new session the classifier cannot resolve a route until `request/header` exists; set `semanticProvider`/`semanticModel` if you want summaries from the very first tool call.
- **Single chip row per session**, and the dock renders the session you are looking at. Upstream's single-line rule is unchanged.
- **The browser half is hook-free on purpose.** It paints imperatively through a ref callback (as upstream does for elapsed seconds) so the bundle's no-renderer verification gate keeps working. React owns `data-activity-phase`; the ticker owns `data-activity-semantic`.
- **An unreachable summary route degrades quietly and cheaply.** The chip keeps the heuristic line. A `403`/`404` means the route is not published here at all, so polling stops for the page's lifetime; a transient failure (network, `5xx`, a restarting host) backs off geometrically to 30 s and resets on the first success. Without that, an origin the host cannot serve would cost one failed request per second for the length of every turn.
- **No tool progress percentages** — DSH has no tool progress events; the line shows elapsed time only.

---

## Development

```sh
npm install
npm run build            # host tsc + client tsc → lib/types/
npm run build:client     # browser bundle → lib/client.js
npm run verify:client-bundle   # build + no-browser bundle gate
npm test                 # vitest: classifier policy, route/fence, projection, status machine
```

`src/semantic.ts` is pure and clock-injected — the model call is an injected function — so the whole debounce/coalescing/consumption/cleaning policy is unit-tested without a provider. `src/narration.ts` (the wording contract, vocabulary and sanitizer chain, adapted from [pi-bar](https://github.com/tianrendong/pi-bar) by tianrendong) is pure too. `src/llm-summarizer.ts` is the only file that touches `ctx.llm`.

## License

BSD-3-Clause, inherited from upstream. Upstream author: chimney ([@ccch1mneyyy](https://github.com/ccch1mneyyy)). Not an official DeepSeek project.

`src/narration.ts` adapts the progress-narration design of [pi-bar](https://github.com/tianrendong/pi-bar) (MIT, © 2026 Jenny Yu) — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
