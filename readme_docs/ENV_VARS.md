# Environment Variables — Complete Reference

This is the full inventory of environment variables the Pluvus workflow prototype reads
at runtime, discovered by sweeping the entire repo (`server/` TypeScript, `agent/` Python,
`web/` Vite). For each var: what it does, its default, whether it's required, and where it's
read.

Two audiences:

1. **Operators** setting up a deploy (Replit / Render / local) — start with the tables below.
2. **Anyone auditing config drift** — the last section (["Undocumented in `.env.example`"](#undocumented-in-envexample))
   lists every var that IS wired in code but is NOT in the committed `.env.example`, split
   into "safe to add" vs "harness/test-only, ignore".

> Legend: **Req?** — ✅ required for that feature to work · ⬜ optional (has a working default) ·
> 🔒 secret (never commit). "Default" = the value used when the var is unset.

---

## 1. Server — core / topology

| Var | Req? | Default | Purpose | Read in |
|---|---|---|---|---|
| `DATABASE_URL` | ✅ 🔒 | — | Postgres/Neon connection string. Server can't persist anything without it. On Replit this is auto-managed. | `server/src/db/drizzle.ts`, `drizzle.config.ts` |
| `REDIS_URL` | ✅ 🔒 | `redis://localhost:6379` | BullMQ queues, per-instance locks, scheduler leader lease. | `server/src/workers/redis.ts`, `scheduler/lock.ts` |
| `PORT` | ⬜ | `3001` | HTTP listen port. | `server/src/index.ts` |
| `NODE_ENV` | ⬜ | `development` | `development`/`test` open-posture; anything else fails closed on missing secrets. Also gates send-delay + provider defaults. | many |
| `PROCESS_ROLE` | ⬜ | `all` | Split topology: `all` (API+workers+scheduler in one) · `api` · `worker` · `scheduler`. Run exactly ONE scheduler. | `server/src/processRole.ts` |
| `WEB_DIST_DIR` | ⬜ | `../../web/dist` | Where the built SPA lives, so the server can serve it same-origin. Absent in dev/split → no-op. | `server/src/app.ts` |

## 2. Workers / concurrency

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `WORKER_CONCURRENCY` | ⬜ | `5` | Base per-worker BullMQ concurrency (the per-queue overrides below win when set). |
| `NODE_EXECUTION_CONCURRENCY` | ⬜ | inherits `WORKER_CONCURRENCY` | Override just the node-execution worker (each slot holds a 45–120s LLM call). |
| `INBOUND_EMAIL_CONCURRENCY` | ⬜ | inherits `WORKER_CONCURRENCY` | Override just the inbound-reply worker. |
| `DELAYED_SEND_CONCURRENCY` | ⬜ | inherits `WORKER_CONCURRENCY` | Override the delayed-send worker (a fast provider send, so it can be higher). |
| `ENABLE_QUEUE_INJECTION` | ⬜ | `false` | Opt-in gate for `POST /queues/*` test-injection endpoints. **NEVER set in a deploy** — they drive the real state machine with fabricated replies. |

## 3. Scheduler

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `SCHEDULER_LEADER_TTL_MS` | ⬜ | `90000` | Redis leader lease so only ONE scheduler polls when several run. Irrelevant with a single `PROCESS_ROLE=all` process. |

### Manual-review timeout (PLU-154)

The poller sweep that expires unresolved `MANUAL_REVIEW` cases and nudges the brand
before the deadline. OFF by default — with `MANUAL_REVIEW_TIMEOUT_ENABLED` unset no
deadline is ever stamped, so the sweep is a no-op and a case sits in MANUAL_REVIEW
until a human acts (today's behavior). Enable in staging/prod so no creator can sit
in MANUAL_REVIEW indefinitely.

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `MANUAL_REVIEW_TIMEOUT_ENABLED` | ⬜ | `false` | Master switch. `true` = stamp a deadline on MR entry, nudge, and expire (→ `EXPIRED`, distinct from `NO_RESPONSE`). |
| `MANUAL_REVIEW_TIMEOUT_MS` | ⬜ | `604800000` | How long (ms) a case may sit in MANUAL_REVIEW before the sweep expires it. Default 7 days. |
| `MANUAL_REVIEW_NUDGE_OFFSETS_MS` | ⬜ | `259200000,86400000` | Comma list of "ms before deadline" to nudge the brand (default 3d, 1d). Nudges target the brand/operator, never the creator. |

## 4. Randomized send delay

Decouples "AI reply generated" from "reply sent" by a random delay so counters don't land
microseconds after the creator's email (a bot-sender deliverability signal). Applies ONLY to
AI negotiation replies — outreach, follow-ups, and transactional emails send immediately.

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `SEND_DELAY_ENABLED` | ⬜ | `true` (non-test) | Master switch. `false` = delay-0 (send immediately, still routed through the queue). **Set `false` while testing** so replies aren't stuck for up to 5 min. |
| `SEND_DELAY_MIN_MS` | ⬜ | `30000` | Lower bound of the uniform random window (30s). |
| `SEND_DELAY_MAX_MS` | ⬜ | `300000` | Upper bound (5 min). If MIN > MAX the feature disables itself (fail-safe). |
| `SEND_DELAY_SWEEP_GRACE_MS` | ⬜ | `120000` | Extra time past MAX before the safety-net sweep reclaims a stranded reservation. |
| `SEND_DELAY_MAX_SWEEP_AGE_MS` | ⬜ | `86400000` | A reservation older than this (24h) is a poison message — left for manual inspection. |
| `SEND_DELAY_MAX_REDRIVES` | ⬜ | `3` | Max times the sweep re-enqueues one reservation before giving up. |

> The delayed-send worker runs at **every** worker-startup site even when `SEND_DELAY_ENABLED=false`
> (disabled is delay-0, not a bypass). With `PROCESS_ROLE=all` this happens automatically.

## 5. Agent service (TS → Python LangGraph)

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `AGENT_SERVICE_URL` | ✅ | `http://localhost:8001` | URL of the Python agent service the TS providers call. |
| `AGENT_PROVIDER` | ⬜ | `mock` in test, else `langgraph` | `mock` (in-process rules, harness only) · `langgraph` (real AI over HTTP). |
| `NEGOTIATION_PROVIDER` | ⬜ | same as above | Same selector for the negotiate path. |
| `AGENT_API_KEY` | ⬜ 🔒 | — | Shared secret; TS sends `Authorization: Bearer`. Set the SAME value on both sides in any deploy. Unset = auth off + warning. |
| `AGENT_ENV` | ⬜ | — | `prod`/`production`/`staging` + empty `AGENT_API_KEY` ⇒ agent auth FAILS CLOSED (503) instead of serving unauthenticated. |
| `AGENT_TIMEOUT_MS` | ⬜ | `120000` | TS-side timeout for the generation routes (`/negotiate`, `/draft`). |
| `AGENT_CLASSIFY_TIMEOUT_MS` | ⬜ | `45000` | Shorter fail-fast timeout for `/classify` only. |
| `AGENT_CB_FAILURE_THRESHOLD` | ⬜ | `5` | Circuit breaker: consecutive failures before the TS side fast-fails to MANUAL_REVIEW. |
| `AGENT_CB_COOLDOWN_MS` | ⬜ | `30000` | How long the breaker stays open before a probe. |
| `AGENT_RATE_LIMIT` | ⬜ | `60` | Agent-side max requests per window per client+route. `0` disables. |
| `AGENT_RATE_WINDOW_SECONDS` | ⬜ | `60` | The window length for the above. |

## 6. Server rate limiting

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | ⬜ | `60000` | GLOBAL bucket window (every request). |
| `RATE_LIMIT_MAX` | ⬜ | `300` | GLOBAL max requests/window. `0` disables. |
| `PUBLIC_RATE_LIMIT_WINDOW_MS` | ⬜ | `60000` | Tighter bucket window for unauthenticated magic-link/webhook/redirect routes. |
| `PUBLIC_RATE_LIMIT_MAX` | ⬜ | `60` | PUBLIC max requests/window. `0` disables. |

## 7. Email (Nylas)

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `EMAIL_PROVIDER` | ⬜ | `mock` | `mock` (no real email) · `nylas` (real send/receive). |
| `NYLAS_API_KEY` | ✅ 🔒 | — | Required when `EMAIL_PROVIDER=nylas`. |
| `NYLAS_GRANT_ID` | ✅ 🔒 | — | The connected mailbox grant. |
| `NYLAS_EMAIL_ADDRESS` | ⬜ | — | Optional address metadata for the legacy grant seeded by the migration runner. |
| `NYLAS_WEBHOOK_SECRET` | ✅ 🔒 | — | Verifies `X-Nylas-Signature` on inbound deliveries; the webhook route rejects events without it. |
| `NYLAS_API_URI` | ⬜ | — | API base override (e.g. `https://api.us.nylas.com`). |
| `WEBHOOK_MAX_AGE_SECONDS` | ⬜ | `300` | Replay-freshness window; a signed delivery older/newer than this is rejected. `0` disables (dup-id guard still applies). |

## 8. Gmail campaign labels

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `GMAIL_LABELS_ENABLED` | ⬜ | `false` | Apply a real `Pluvus/<Campaign>` Gmail label to each campaign thread. Best-effort, post-send, never blocks delivery. Needs a Gmail grant with mail-MODIFY scope. |
| `GMAIL_LABEL_PREFIX` | ⬜ | `Pluvus` | The parent label namespace in Gmail's sidebar. |

## 9. Escalation / notifications

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `BRAND_NOTIFY_EMAIL` | ⬜ | operator address | Where MANUAL_REVIEW escalation emails go. Precedence: campaign `notifyEmail` → this → `affiliatepartner@pluvus.com`. |

## 10. Secrets posture / operator gate

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `OPERATOR_API_KEY` | ⬜ 🔒 | — | Shared secret the dashboard sends as `X-Operator-Key` to reach operator money/data routes. Open when unset in dev; set in any exposed env. |
| `ALLOW_OPEN_SECRETS` | ⬜ | — | Set `true` to deliberately re-open the fail-closed posture in a non-dev/test env (throwaway staging). Leave unset everywhere else. |

## 11. Logging / observability

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `LOG_FILE` | ⬜ | — | Explicit path; every console line is ALSO appended here (readable when detached/behind a tunnel). |
| `LOG_DIR` | ⬜ | — | A directory → appends `<dir>/server.log` (ignored if `LOG_FILE` set). |
| `STUCK_STATE_AGE_MS` | ⬜ | `1800000` | A non-terminal instance older than this (30 min) is counted "stuck" in worker metrics + P9 alerts. |
| `LLM_DAILY_SPEND_ALERT_USD` | ⬜ | — | Daily spend MONITOR: `/observability/llm` reports `spendGuard.exceeded` once trailing-24h spend crosses it. Does not block. |
| `LLM_USAGE_PERSIST` | ⬜ | — | Harness-only: persist `LlmCall` telemetry during harness runs (live path persists automatically). |

## 12. Spend guards (shared TS + agent)

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `LLM_MAX_REQUEST_COST_USD` | ⬜ | `0` (off) | Per-request hard cap; a request whose running estimated cost crosses this stops mid-flight (agent → 503). Dormant on local Ollama ($0). |

---

## 13. Agent service (Python) — LLM providers

The agent has **no central config file**; every var is read inline in `agent/app/`. `LLM_PROVIDER`
is the global default; each role (`NEGOTIATE`, `CLASSIFY`, `DRAFT`) can override via
`LLM_PROVIDER_<ROLE>` and inherits the global when blank.

| Var | Req? | Default | Purpose |
|---|---|---|---|
| `LLM_PROVIDER` | ⬜ | `ollama` | Global default backing every agent: `anthropic` · `deepseek` · `ollama` · `openrouter`. |
| `LLM_FALLBACK_PROVIDER` | ⬜ | — | Fail over to this provider on a primary failure. Blank = no failover. |
| `LLM_PROVIDER_NEGOTIATE` / `_CLASSIFY` / `_DRAFT` | ⬜ | inherit `LLM_PROVIDER` | Per-task provider override (mixed-model deploy). |
| `LLM_FALLBACK_PROVIDER_<ROLE>` | ⬜ | inherit `LLM_FALLBACK_PROVIDER` | Per-task failover. |
| `NEGOTIATION_STRATEGY` | ⬜ | `rules` (per code) / `llm` (per `.env.example`) | `rules` (code picks action+number) · `llm` (model picks, bounded by floor/ceiling + round cap). |

### OpenRouter (`LLM_PROVIDER=openrouter`)
| Var | Req? | Default | Purpose |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ 🔒 | — | One key proxies many upstreams. |
| `OPENROUTER_MODEL` | ⬜ | — (per-role scoped) | Global model slug → negotiate + classify. `.env.example` pins `anthropic/claude-opus-4.8`. |
| `OPENROUTER_MODEL_DRAFT` | ⬜ | inherits `OPENROUTER_MODEL` | Cheaper copy model for drafting. |
| `OPENROUTER_BASE_URL` | ⬜ | `https://openrouter.ai/api/v1` | Proxy override. |
| `OPENROUTER_MAX_TOKENS` | ⬜ | `768` | Cap on generated tokens. |
| `OPENROUTER_TIMEOUT_SECONDS` | ⬜ | `60` | Per-request SDK timeout. |
| `OPENROUTER_MAX_RETRIES` | ⬜ | `2` | SDK auto-retries on 429/5xx. |

### Anthropic (`LLM_PROVIDER=anthropic`)
| Var | Req? | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ 🔒 | — | Required when provider is anthropic. |
| `ANTHROPIC_MODEL` | ⬜ | `claude-opus-4-8` (per `.env.example`) | Exact model id pin. |
| `ANTHROPIC_MAX_TOKENS` | ⬜ | `768` | Cap on generated tokens. |
| `ANTHROPIC_TIMEOUT_SECONDS` | ⬜ | `60` | Per-request SDK timeout. |
| `ANTHROPIC_MAX_RETRIES` | ⬜ | `2` | SDK auto-retries. |

### DeepSeek (provider slot = deepseek)
| Var | Req? | Default | Purpose |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ 🔒 | — | Required when a slot resolves to deepseek. |
| `DEEPSEEK_MODEL` | ⬜ | `deepseek-chat` | Model pin. |
| `DEEPSEEK_BASE_URL` | ⬜ | `https://api.deepseek.com` | Proxy override. |
| `DEEPSEEK_MAX_TOKENS` | ⬜ | `768` | Cap on generated tokens. |
| `DEEPSEEK_TIMEOUT_SECONDS` | ⬜ | `60` | Per-request SDK timeout. |
| `DEEPSEEK_MAX_RETRIES` | ⬜ | `2` | SDK auto-retries. |

### Ollama (`LLM_PROVIDER=ollama`, local dev)
| Var | Req? | Default | Purpose |
|---|---|---|---|
| `OLLAMA_MODEL` | ⬜ | `qwen3:8b` | Local model tag. |
| `OLLAMA_BASE_URL` | ⬜ | `http://localhost:11434` | Ollama server URL. |
| `OLLAMA_MODEL_DIGEST` | ⬜ | — | Pin to an immutable build digest so a re-pull can't silently change the decision path. |
| `OLLAMA_KEEP_ALIVE` | ⬜ | (code default) | Keep the model resident between calls (avoids cold-load latency). |
| `OLLAMA_NUM_CTX` | ⬜ | `8192` | Context window. |
| `OLLAMA_NUM_PREDICT` | ⬜ | `768` | Global default generated-token cap. |

### Agent — auth / limits / tuning
| Var | Req? | Default | Purpose |
|---|---|---|---|
| `AGENT_ENV` | ⬜ | — | (agent side) `prod`/`production`/`staging` ⇒ enforce Bearer auth. |
| `AGENT_RATE_LIMIT` / `AGENT_RATE_WINDOW_SECONDS` | ⬜ | `60` / `60` | Agent-side rate limit (mirrors §5). |
| `LLM_INVOKE_TIMEOUT_SECONDS` | ⬜ | `60` | Python per-invoke wall-clock budget; bounds a hung `llm.invoke`. `0` disables. |
| `LLM_INVOKE_POOL_SIZE` | ⬜ | (code default) | Size of the invoke thread pool. |
| `LLM_NEGOTIATE_NUM_PREDICT` | ⬜ | (code default) | Per-call token cap override for the negotiate route's long JSON. |

---

## Undocumented in `.env.example`

These ARE wired in code but are **NOT** in the committed `.env.example`. None are
payment- or attribution-based. Split into two groups.

### A. Real runtime vars worth documenting / optionally setting

| Var | Where | Purpose | Recommendation |
|---|---|---|---|
| `NYLAS_THREAD_URL_TEMPLATE` | `providers/nylas/nylasEmailProvider.ts:73` | Template to build a clickable Gmail thread URL (`{threadId}` placeholder). Unset → links omitted (graceful). | Optional. Add if you want thread deep-links in escalation emails. |
| `GMAIL_THREAD_URL_TEMPLATE` | `notifications/escalation.ts:361` | Template for the "open this thread in Gmail" link in escalation notices (`{messageId}`/`{threadId}`). Falls back to a Gmail search URL. | Optional. Has a working default. |
| `WEB_DIST_DIR` | `app.ts:171` | Override where the built SPA is served from. Defaults to `../../web/dist`. | Rarely needed — only for a non-standard build layout. |
| `OLLAMA_KEEP_ALIVE` / `OLLAMA_NUM_CTX` / `OLLAMA_NUM_PREDICT` | `agent/app/llm.py` | Local Ollama tuning. Irrelevant once you're on OpenRouter. | Add to `.env.example`'s Ollama block for completeness; not needed for a hosted run. |
| `LLM_INVOKE_POOL_SIZE` | `agent/app/structured.py:50` | Invoke thread-pool size. | Optional tuning; default is fine. |
| `LLM_NEGOTIATE_NUM_PREDICT` | `agent/app/routes/negotiate.py:928` | Token cap for the negotiate JSON. | Optional tuning; default is fine. |
| `OPENROUTER_HTTP_REFERER` / `OPENROUTER_APP_TITLE` | `agent/app/llm.py:324-325` | Optional OpenRouter attribution headers (shown in their dashboard). | Nice-to-have; purely cosmetic on OpenRouter's side. |
| `LLM_PRICE_TABLE` | `agent/app/telemetry.py:101` | Override the built-in per-model price table used for cost estimation/observability. | Optional; only if a model's price drifts from the built-in table. |

### B. Harness / test / eval-only — do NOT set in a deploy

These exist only for local harnesses, the eval runner, or unit tests. Listing them so the
audit is complete; none belong in a production/Replit env.

| Var | Where | Purpose |
|---|---|---|
| `HARNESS_STAMP` | `server/src/engine/*.harness.ts` | Deterministic id stamp for harness runs. |
| `UPLOADS_DIR` | `storage/localFileStorage.ts`, harnesses | Local upload dir for harness/file-storage tests. |
| `AGENT_URL` | `agent/tests/negotiation_eval/*` | Target the eval runner points at (a session-owned `:8002`, not the live service). |
| `TIMEOUT_S` | eval runners | Per-request timeout for the eval harness. |
| `OUT` / `OUT_500` | eval runners | Output file path for eval results. |
| `SINGLE_ONLY` / `CONVO_ONLY` | `run_eval.py` | Restrict the eval to single-turn or multi-turn cases. |
| `RUN_LLM_EVAL` | `agent/eval/run.py`, gate tests | Opt-in flag to run the (slow, live) LLM eval gate. |
| `COST_IN_PER_MTOK` / `COST_OUT_PER_MTOK` | `dataset_500/subset_live.py` | Manual cost overrides for the 500-case subset run. |

---

## TL;DR for the current Replit deploy

You're on OpenRouter + Replit-managed DB, not touching payment/attribution flows. Minimum set:

**Must have:** `DATABASE_URL` (Replit-managed), `REDIS_URL`, `OPENROUTER_API_KEY`,
`NYLAS_API_KEY` / `NYLAS_GRANT_ID` / `NYLAS_WEBHOOK_SECRET`, `AGENT_API_KEY`,
`OPERATOR_API_KEY` (+ `VITE_OPERATOR_API_KEY` in the web bundle), `AGENT_SERVICE_URL`,
`EMAIL_PROVIDER=nylas`, `LLM_PROVIDER=openrouter`, `OPENROUTER_MODEL`.

**Worth setting:** `SEND_DELAY_ENABLED=false` while testing (else replies wait up to 5 min),
`AGENT_ENV=production` (fail-closed agent auth), `BRAND_NOTIFY_EMAIL` (custom escalation inbox).
Set `NYLAS_EMAIL_ADDRESS` before the PLU-121 migration if you want the seeded
legacy mailbox to display its real address immediately.

**Everything else** has a safe default — leave unset.
