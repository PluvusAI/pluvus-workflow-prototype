# Deployment Guide — Pluvus Workflow Platform (Replit)

This is the **single source of truth for deploying the whole system**: what runs where,
every key required, the exact order of operations, and the go-live checklist.

Target platform: **Replit** (Reserved VM deployments) for compute, **Neon** for Postgres,
**Upstash** for Redis, plus the managed third parties the app already talks to
(Nylas email, OpenRouter LLM).

> The general product/architecture README is [`README.md`](./README.md). This file is
> **only** about getting it running in production. Ops runbooks referenced below live in
> [`readme_docs/ops/`](./readme_docs/ops/).

---

## 1. What we are deploying (the topology)

The monorepo is **three deployable applications** plus **three managed dependencies**.
On Replit each always-on application is its own **Repl + Reserved VM deployment**.

```
                         ┌────────────────────────────────────────────┐
   creators (email) ───► │  Nylas  ── webhook ──►  Server Repl (all)   │
                         │                          ▲   │              │
   operator (browser) ──►│  web (static SPA) ───────┘   │              │
                         │        X-Operator-Key         ▼             │
                         │  Server Repl also runs:  ◄─ Upstash Redis   │
                         │   • worker fleet (BullMQ)                   │
                         │   • scheduler (30s poller, single leader)   │
                         │        │                                    │
                         │        ▼  AGENT_SERVICE_URL (Agent Repl URL)│
                         │  Agent Repl (FastAPI/LangGraph) ─► OpenRouter│
                         │        │                                    │
                         │        ▼  DATABASE_URL (Neon serverless)    │
                         │  Neon Postgres                              │
                         └────────────────────────────────────────────┘
```

### The three apps (all from this one repo)

| # | App | Folder | Stack | Replit deployment | Notes |
|---|-----|--------|-------|-------------------|-------|
| 1 | **Server (API + Workers + Scheduler)** | `server/` | Node 20, Express, Drizzle, BullMQ | **Reserved VM** (one Repl, one process) | Runs `PROCESS_ROLE=all` — all three roles in ONE process. |
| 2 | **Agent (AI)** | `agent/` | Python 3.11, FastAPI, LangGraph | **Reserved VM** (second Repl) | Private-ish: locked by `AGENT_API_KEY`. The server calls it over its Repl URL. |
| 3 | **Dashboard** | `web/` | React 18 + Vite (static build) | **served by the Server Repl** (no separate deploy) | Build to `web/dist`; the server serves it same-origin. Baked-in operator key. |

**Why `PROCESS_ROLE=all` on Replit.** A Replit Reserved VM is **one always-on process**.
The server normally splits into three services (api / worker / scheduler) so they scale
independently — but Replit's one-process model maps perfectly onto the server's built-in
`PROCESS_ROLE=all` mode (see `server/processRole.ts`), which runs the HTTP API, the BullMQ
worker, and the single scheduler poller **in the same process**. This is the pre-split,
single-node behavior and is exactly what you want on a single Reserved VM.

The rules that still matter in this single-node mode:

- **Exactly ONE server Repl runs.** Because api + worker + **scheduler** all live in one
  process, running a second copy of the server Repl would double-fire the 30s poller. There
  is a Redis leader-lease safety net (`SCHEDULER_LEADER_TTL_MS`) but do not lean on it —
  keep **one** server deployment. (If you ever need to scale workers, that's when you split
  back into Render-style multi-service; on Replit, scale vertically first.)
- **The server is the only public HTTP surface.** It serves the **creator-facing HTML pages**
  (payment form, payout confirm/dispute), so its public Repl URL is what creator email links
  and the Nylas webhook are minted against (`PAYMENT_BASE_URL`).
- **Reserved VM, not Autoscale.** Autoscale deployments **sleep when idle**. The scheduler
  poller and BullMQ workers must run continuously even with zero HTTP traffic, so the server
  **must** be a Reserved VM. (Same for the agent, since the server calls it synchronously.)

### The three managed dependencies

| Dependency | What for | Provider | Notes |
|---|---|---|---|
| **Postgres** | All persistent state | **Neon** (must be Neon) | The server uses `@neondatabase/serverless` (WebSocket driver) — it needs a **Neon** endpoint. Do **not** use Replit's built-in Postgres. |
| **Redis** | BullMQ queues + scheduler locks | **Upstash** (managed serverless Redis) | Replit has no managed Redis. Upstash gives a `rediss://` TLS URL. ⚠ Requires a one-line code fix — see §6. |
| **Email** | Outbound + inbound creator email | **Nylas** | Already connected; only the webhook URL + secret need re-pointing to the Repl URL. |
| **LLM** | Classification / negotiation / drafting | **OpenRouter** | One key, per-role model slugs. Verify slugs before the first paid run. |

---

## 2. Accounts & keys you need before you start

Gather these first. Every one maps to an env var in §5. On Replit these go into each Repl's
**Secrets** pane (the lock icon) — Replit injects them as environment variables. **Never** put
them in `.env` on a public Repl or commit them.

| # | Thing to get | Where | Produces |
|---|---|---|---|
| 1 | **Neon project + branch** | https://neon.tech | `DATABASE_URL` (pooled connection string, `?sslmode=require`) |
| 2 | **Replit account** (Core plan for Reserved VM) | https://replit.com | hosts the server + agent Repls |
| 3 | **Upstash Redis database** | https://upstash.com | `REDIS_URL` (the `rediss://` connection string) |
| 4 | **OpenRouter API key** | https://openrouter.ai/keys | `OPENROUTER_API_KEY` |
| 5 | **Nylas API key + Grant ID** | https://dashboard.nylas.com (already set up) | `NYLAS_API_KEY`, `NYLAS_GRANT_ID`, optionally `NYLAS_EMAIL_ADDRESS` |
| 6 | **Nylas webhook secret** | Created when you register the webhook (§8) | `NYLAS_WEBHOOK_SECRET` |
| 7 | **Two secrets you generate yourself** | node crypto (below) | `ATTRIBUTION_WEBHOOK_SECRET`, `OPERATOR_API_KEY` |

Generate the two self-minted secrets (run locally, or in a Repl shell):

```bash
# Operator dashboard key (also becomes VITE_OPERATOR_API_KEY on the web build)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# Attribution webhook secret (money integrity — required in production)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

> **Never commit these.** `.env` is gitignored. Run `npm run scan:secrets` before any commit —
> it fails on live-secret patterns in tracked files. On Replit, prefer the **Secrets** pane over
> a `.env` file. See [`readme_docs/ops/SECRETS.md`](./readme_docs/ops/SECRETS.md).

---

## 3. Deployment order (the happy path)

Do these in order. Each step is expanded in the sections below.

1. **Provision data stores** — Neon Postgres + Upstash Redis. [§4]
2. **Apply the DB migrations** to a fresh Neon branch (`apply-all-migrations.ts`). [§4]
3. **Build the dashboard** (`web/dist`) with `VITE_OPERATOR_API_KEY` set — the server serves it. [§7c]
4. **Create the Agent Repl** (import the repo, root `agent/`), set its Secrets, deploy as a
   Reserved VM, and grab its public URL. [§7a]
5. **Create the Server Repl** (import the whole repo), set its Secrets including
   `AGENT_SERVICE_URL` = the Agent Repl URL, deploy as a Reserved VM. [§7b]
6. **Set `PAYMENT_BASE_URL`** to the Server Repl's public URL and redeploy the server. [§8]
7. **Re-point the Nylas webhook** to `https://<server-repl>/webhooks/nylas` and set the secret. [§8]
8. **Smoke-test** the go-live checklist. [§9]

> The §6 Redis auth/TLS handling and the single-origin dashboard serving are **already in the
> code** — there is no pre-deploy code patch to apply.

---

## 4. Data stores

### Neon Postgres
1. Create a project + a **production branch** in Neon.
2. Copy the **pooled** connection string → this is `DATABASE_URL`. Keep `?sslmode=require`.
3. **Apply migrations.** The migration SQL lives in `server/prisma/migrations/` (Prisma runtime
   is gone; the `.sql` files are the schema of record). For a **fresh** Neon branch, apply all
   migrations in order with the bundled all-in-one runner. Run from a **shell** (local, or the
   Server Repl's Shell tab) with `DATABASE_URL` and the legacy
   `NYLAS_GRANT_ID` set. Optionally set `NYLAS_EMAIL_ADDRESS` so the seeded
   account has the real mailbox address in the dashboard:

   ```bash
   cd server
   npx tsx prisma/apply-all-migrations.ts --dry-run   # preview the plan (no DB writes)
   npx tsx prisma/apply-all-migrations.ts             # apply every pending migration in order
   ```

   The runner applies each migration dir oldest→newest and records applied names in a
   `_migrations_applied` ledger, so re-running is safe (it **skips** already-applied files). It
   automatically runs enum-growth migrations (`ALTER TYPE … ADD VALUE`) and self-managed-txn
   migrations **without** a wrapping transaction — so the classic "enum add can't run in a
   transaction" failure does not happen. The `--dry-run` output tags each file `[transaction]`,
   `[no-wrap (enum add)]`, or `[no-wrap (self-managed txn)]`.

   The runner passes `NYLAS_GRANT_ID` into the same PostgreSQL transaction that runs
   PLU-121. Existing campaigns, executions, and messages are therefore backfilled
   to an active default account for the exact legacy grant. If the value is absent
   or is `UNCONFIGURED_DEFAULT_GRANT`, the migration intentionally creates a
   disabled, non-default placeholder instead of making a fake grant send-capable.
   Because applied migrations are skipped, set these values before the first
   application of PLU-121; for an experimental database where it already ran,
   recreate the database or reconcile the seed row explicitly.

   This is safe with Neon's pooled connection string: the runner applies the
   mailbox settings inside the same transaction as PLU-121, so transaction-mode
   pooling cannot switch away from the configured backend before the seed runs.

   > ⚠ **Fresh DB only.** The ledger is created by this runner, so point it at a **new** Neon
   > branch for go-live. Do **not** run it against a DB already migrated the old way
   > (single-file `apply-migration.ts`) — with no ledger it would try to re-apply everything and
   > fail on "already exists." For a one-off single file (e.g. a late hotfix migration) the
   > original runner still works: `npx tsx prisma/apply-migration.ts prisma/migrations/<dir>/migration.sql`.

### Upstash Redis
1. Create a database at https://upstash.com → **Redis** → pick a region close to your Repls.
2. Copy the connection string. Use the **TLS** endpoint — it looks like
   `rediss://default:<password>@<host>.upstash.io:6379`. This is `REDIS_URL`.
3. ⚠ That URL carries a **username + password** and uses **TLS** (`rediss://`). The current
   code drops all three — **apply the §6 fix first**, or BullMQ will fail with `NOAUTH` /
   connection reset.
4. Upstash's free tier has a per-day command cap; the 30s scheduler poller + BullMQ heartbeats
   are light, but if you see throttling, upgrade the Upstash plan (it's the cheapest lever).

---

## 5. Environment variables — the complete inventory

Full annotated list is in [`.env.example`](./.env.example). Below is grouped by **which Repl
needs it** and flagged **required vs optional** for a live Replit deploy. On Replit set these in
each Repl's **Secrets** pane.

### Set on the Server Repl (`PROCESS_ROLE=all`)

| Key | Required | Value for this deploy |
|---|---|---|
| `NODE_ENV` | ✅ | `production` (turns on the fail-loud secret guard) |
| `PROCESS_ROLE` | ✅ | `all` (api + worker + scheduler in one process — the Replit single-node mode) |
| `DATABASE_URL` | ✅ | Neon pooled connection string |
| `REDIS_URL` | ✅ | Upstash `rediss://` connection string |
| `ATTRIBUTION_WEBHOOK_SECRET` | ✅ | your generated secret (server **refuses to boot** without it in prod) |
| `OPERATOR_API_KEY` | ✅ | your generated operator key (server refuses to boot without it in prod) |
| `AGENT_SERVICE_URL` | ✅ | the **Agent Repl's public URL** (e.g. `https://pluvus-agent.<user>.repl.co` or its Reserved-VM deploy URL) |
| `AGENT_API_KEY` | ✅ | shared secret; same value set on the Agent Repl |
| `AGENT_PROVIDER` | ✅ | `langgraph` |
| `NEGOTIATION_PROVIDER` | ✅ | `langgraph` |
| `EMAIL_PROVIDER` | ✅ | `nylas` |
| `NYLAS_API_KEY` | ✅ | from Nylas |
| `NYLAS_GRANT_ID` | ✅ | from Nylas |
| `NYLAS_EMAIL_ADDRESS` | optional | address belonging to `NYLAS_GRANT_ID`; used as migration seed metadata |
| `NYLAS_WEBHOOK_SECRET` | ✅ | from webhook registration (§8) |
| `PAYMENT_BASE_URL` | ✅ | the **Server Repl public URL** (§8) — creator links + webhook are minted from this |
| `PORT` | ✅ | Replit sets this; the app reads it. Bind to `0.0.0.0:$PORT`. |
| `WORKER_CONCURRENCY` | optional | default `5`; on one VM keep modest (each slot holds a 45–120s LLM call) |
| `SCHEDULER_LEADER_TTL_MS` | optional | default `90000` |
| `BRAND_NOTIFY_EMAIL` | optional | workspace-wide fallback for manual-review notices |
| `LLM_DAILY_SPEND_ALERT_USD` | recommended | daily spend alarm surfaced on `/observability/llm` + `/observability/alerts`, e.g. `25`. **Server-side** (the agent does not read it). |
| `ENABLE_QUEUE_INJECTION` | ✅ leave **unset/false** | never enable in a deployed env (it can inject fake creator replies) |
| `WEB_DIST_DIR` | optional | override the built-dashboard path the server serves (defaults to `web/dist`); leave unset for the standard single-origin deploy |
| `LOG_DIR` or `LOG_FILE` | optional | mirror logs to a file for the live log; see [`readme_docs/ops/ALERTING.md`](./readme_docs/ops/ALERTING.md) |

### Set on the Agent Repl (Python)

| Key | Required | Value |
|---|---|---|
| `LLM_PROVIDER` | ✅ | `openrouter` |
| `OPENROUTER_API_KEY` | ✅ | from OpenRouter |
| `OPENROUTER_MODEL` | ✅ | money/decision model slug, e.g. `anthropic/claude-opus-4.8` — **verify on openrouter.ai/models** |
| `OPENROUTER_MODEL_DRAFT` | optional | cheaper copy model for drafting (blank → inherits `OPENROUTER_MODEL`) |
| `NEGOTIATION_STRATEGY` | ✅ | `llm` (or `rules` for deterministic) |
| `AGENT_API_KEY` | ✅ | same shared secret as the server |
| `AGENT_ENV` | ✅ | `production` — makes the agent **fail closed** (503) if `AGENT_API_KEY` is empty |
| `PORT` | ✅ | Replit sets this; start uvicorn on `0.0.0.0:$PORT` |
| `LLM_MAX_REQUEST_COST_USD` | ✅ recommended | per-request hard cap, e.g. `0.50` — kills a runaway negotiation loop |
| `LLM_INVOKE_TIMEOUT_SECONDS` | optional | default `60` |
| `BRIEF_OCR_FALLBACK_ENABLED` | optional | `true` to OCR **scanned / image-only** campaign briefs when pypdf finds no text layer. **Off by default.** Requires the OCR system binaries below — see the note. |

> Note: `LLM_DAILY_SPEND_ALERT_USD` is a **server**-side setting (it is read by the server's
> observability layer, not the agent). Set it on the **Server Repl**, not here — see the server
> table above.

> **OCR fallback for scanned briefs (`BRIEF_OCR_FALLBACK_ENABLED`).** pypdf only reads an
> *embedded* text layer, so a scanned / image-only brief PDF parses to "" and the negotiation
> agent gets no brief knowledge. With this flag on, the agent OCRs such briefs
> (`agent/app/brief.py` → OCRmyPDF + Tesseract, CPU-only) and re-extracts. It runs **only when the
> normal text pass is empty/thin**, so ordinary text PDFs pay nothing, and it **degrades to ""**
> (never breaks a run) if OCR is unavailable or fails. It needs three **system binaries** on PATH,
> which pip cannot install:
> - **Replit:** already declared in [`agent/replit.nix`](./agent/replit.nix) (`tesseract`, `qpdf`).
> - **A plain CPU VPS / Docker:** `apt-get install -y tesseract-ocr tesseract-ocr-eng qpdf`
>   (add `ghostscript` only if you don't use the bundled pypdfium2 rasterizer).
>
> The pip packages (`ocrmypdf`, `pypdfium2`) ship in the agent's `.[ai]` extra. Footprint is small
> (~150–300 MB) and CPU-only — **no GPU needed**. A short feasibility comparison of the OCR options
> (why OCRmyPDF/Tesseract over PaddleOCR / EasyOCR / Baidu Unlimited-OCR) is in
> [`readme_docs/OCR_FALLBACK_FEASIBILITY.md`](./readme_docs/OCR_FALLBACK_FEASIBILITY.md).

> ⚠ **Verify OpenRouter model slugs before the first paid run.** Slugs get renamed
> (`deepseek/deepseek-chat-v3` was already dead → the `deepseek-v4-*` family). Confirm each slug
> resolves on https://openrouter.ai/models. `anthropic/claude-opus-4.8` was valid at last check.

### Set on the Web (static build — baked in at build time)

| Key | Required | Value |
|---|---|---|
| `VITE_OPERATOR_API_KEY` | ✅ | the **same** value as `OPERATOR_API_KEY` — the dashboard sends it as `X-Operator-Key`. Must be set **at build time** (baked into the bundle). |
| API base | n/a | No config needed — the SPA uses a relative `/api` base and the **Server Repl serves it same-origin** (§7c). No `VITE_API_BASE_URL`, no CORS. |

---

## 6. Redis auth/TLS — already wired (reference)

**No action needed — this is already in the code.** `server/src/workers/redis.ts`
(`redisConnection()`) reads the **username, password, and TLS** scheme from `REDIS_URL`, so
Upstash's authed `rediss://` endpoint connects out of the box:

```ts
const u = new URL(url);
return {
  host: u.hostname || "127.0.0.1",
  port: u.port ? Number(u.port) : 6379,
  username: u.username || undefined,   // Upstash: "default"
  password: u.password || undefined,   // Upstash: the token in the URL
  tls: u.protocol === "rediss:" ? {} : undefined,  // rediss:// → TLS on
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};
```

`server/src/scheduler/lock.ts` uses `createClient({ url })` from `redis`, which already parses
the full URL. Both the BullMQ queues and the scheduler lock therefore work against Upstash with
just `REDIS_URL` set — plaintext local `redis://localhost` still works too (username/password/tls
stay unset).

---

## 7. Deploying each app on Replit

Two always-on Repls: the **Server Repl** (whole repo; root [`.replit`](./.replit)) and the
**Agent Repl** (root `agent/`; [`agent/.replit`](./agent/.replit)). Each is published as a
**Reserved VM** deployment. The dashboard is served by the Server Repl (§7c) — no third Repl.

### 7a. Agent (Python) — deploy FIRST (the server depends on it)
- **Create Repl → Import from GitHub**, select this repo. Set the Repl's run root to `agent/`.
- Runtime: Python 3.11. Install deps: `pip install -e ".[ai]"`.
- Run command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
- Set the Agent Secrets from §5 (`OPENROUTER_API_KEY`, `AGENT_API_KEY`, `AGENT_ENV=production`, …).
- **Deploy → Reserved VM.** Health check path: `/health`.
- After it's live, copy its **public deployment URL** — that becomes `AGENT_SERVICE_URL` on the
  server. The agent is locked by `AGENT_API_KEY` + `AGENT_ENV=production` (it returns 503 if the
  key is missing), so it is safe even though the URL is reachable.

Suggested `agent/.replit`:

```toml
run = "uvicorn app.main:app --host 0.0.0.0 --port $PORT"
entrypoint = "app/main.py"
modules = ["python-3.11"]

[deployment]
deploymentTarget = "vm"
run = ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "$PORT"]
build = ["pip", "install", "-e", ".[ai]"]
```

### 7b. Server (Node) — ONE Reserved VM, `PROCESS_ROLE=all`
- **Create Repl → Import from GitHub**, this repo (import the **whole repo** — it's an npm
  workspace; a `server/`-only import can't resolve `@pluvus/server`'s local deps).
- Build (from repo root): install deps, build the **server**, and build the **dashboard** so
  `web/dist` ships in the same Repl (§7c):
  ```bash
  npm ci
  npm --workspace @pluvus/web run build       # → web/dist  (needs VITE_OPERATOR_API_KEY at build)
  npm --workspace @pluvus/server run build     # → server/dist
  ```
- Run command: `node server/dist/index.js` with `PROCESS_ROLE=all`.
- Set the full **Server Repl** Secrets block from §5 — including `AGENT_SERVICE_URL` = the Agent
  Repl URL from 7a, `PROCESS_ROLE=all`, and `VITE_OPERATOR_API_KEY` (needed **at build time** so
  the dashboard bakes it in — set it before the build runs).
- **Deploy → Reserved VM.** Health check `/health`. This is the **public** URL creator links and
  the Nylas webhook point at, and where the dashboard is served.
- Run migrations (§4) once against Neon before/at first boot (from the Repl Shell or locally).
- **Keep this to ONE deployment** — the scheduler poller lives in this process (see §1).

Suggested root `.replit` (import the whole repo; the server is the primary app):

```toml
run = "node server/dist/index.js"
modules = ["nodejs-20"]

[env]
PROCESS_ROLE = "all"
NODE_ENV = "production"

[deployment]
deploymentTarget = "vm"
# VITE_OPERATOR_API_KEY must be present in the deploy env so the web build bakes it in.
build = ["sh", "-c", "npm ci && npm --workspace @pluvus/web run build && npm --workspace @pluvus/server run build"]
run = ["node", "server/dist/index.js"]
```

> Because the whole repo is imported and built from the root, `web/dist` and `server/dist` sit at
> their normal repo paths — the server finds `web/dist` relative to itself with no extra config.

### 7c. Web dashboard — served by the Server Repl (single origin)
**The server already serves the built dashboard** — no separate web deployment is required, and
no CORS/base-URL wiring is needed. The recommended path:

1. Build the SPA from the repo root, with the operator key set at **build time**:
   ```bash
   VITE_OPERATOR_API_KEY=<your-operator-key> npm --workspace @pluvus/web run build   # → web/dist
   ```
2. Ship `web/dist` alongside the server in the same Repl. On boot, `server/src/app.ts` detects
   `web/dist` (via `existsSync`, override with `WEB_DIST_DIR`) and:
   - serves the static assets, and
   - re-mounts the operator API under `/api/*` (same `X-Operator-Key` gate), which is exactly the
     relative base the SPA's API client uses (`web/src/api/client.ts` → `/api/...`).
   So the dashboard and its API calls are **same-origin** — the dev Vite proxy is not needed in
   prod.
3. Open the dashboard at the Server Repl's public URL (root path). The `VITE_OPERATOR_API_KEY`
   baked into the build is sent as `X-Operator-Key` on every call.

> If `web/dist` is absent, the server simply skips static serving (a no-op) — this is why local
> dev, where Vite serves the SPA on its own port, is unaffected. There is **no** standalone
> Replit "Static deployment" step in this topology.

---

## 8. Wire the public URL + Nylas webhook

The Server Repl is the origin every creator link and the inbound webhook are built from.

1. After the Server Repl's Reserved VM is live, copy its public URL
   (e.g. `https://pluvus-server.<user>.repl.co` or the deployment's `.replit.app` URL).
2. Set **`PAYMENT_BASE_URL`** to that URL in the Server Repl Secrets and redeploy.
   (Locally the tunnel launcher keeps this in sync — see
   [`readme_docs/ops/STABLE_URL.md`](./readme_docs/ops/STABLE_URL.md) — but a Replit Reserved VM
   gives you a stable host, so you set it once.)
3. In the **Nylas dashboard**, point the webhook destination at
   `https://<server-repl-host>/webhooks/nylas`. Nylas probes with `HEAD`/`GET` (challenge) before
   saving — the route already answers both.
4. Copy the **webhook secret** Nylas returns into `NYLAS_WEBHOOK_SECRET` in the Server Repl
   Secrets and redeploy. Without it the webhook route rejects inbound deliveries.

**Which routes are public vs gated** (so a creator link is never blocked):
- **Gated** by `X-Operator-Key`: `/payouts`, `/campaigns`, `/partnerships`, `/observability`,
  `/manual-queue`, `/workflows`, `/creators`, `/uploads`, `/queues`.
- **Open** (creator magic-links / webhooks — must stay open): `/health`, `/webhooks`, `/payment`,
  `/t`, `/attribution`, `/payout/confirm`, `/payout/dispute`.

---

## 9. Go-live smoke checklist

Run these after everything is deployed:

- [ ] `GET https://<server-host>/health` → `200 {"status":"ok"}`.
- [ ] `GET https://<server-host>/observability/meta` **without** `X-Operator-Key` → **401**;
      **with** the key → 200. (Confirms the operator gate.)
- [ ] `GET https://<agent-host>/health` → 200; `/metrics` without `AGENT_API_KEY` → 401/503.
- [ ] `GET /observability/alerts` (with key) → a JSON roll-up with `status: ok|warning|critical`.
      Point your uptime monitor at this. See [`readme_docs/ops/ALERTING.md`](./readme_docs/ops/ALERTING.md).
- [ ] **The dashboard loads at the Server Repl root URL** (`https://<server-host>/`) and its
      `/api/*` data calls succeed (200s, not 404/401) — this confirms both static serving and the
      re-mounted `/api` routers with the baked-in operator key.
- [ ] Enroll **one test creator** (an `@example.com`/`.test` address — these are recognized test
      addresses) and launch → confirm `ENROLLED → OUTREACH_SENT` in the dashboard and a real email
      lands. Then reply and confirm the classify → negotiate loop runs on OpenRouter.
- [ ] Confirm the server is the **only** deployment running (one server Repl → one scheduler poller).
- [ ] After testing, purge test data: `npm run db:clean:harness` (dry-run) →
      `npm run db:clean:harness:apply`. See [`readme_docs/ops/TEST_DATA_SEPARATION.md`](./readme_docs/ops/TEST_DATA_SEPARATION.md).

---

## 10. Cost & spend guardrails

- **OpenRouter** is the only per-use cost on the AI path. `LLM_MAX_REQUEST_COST_USD` caps a
  single request (kills a runaway loop → agent returns 503 → orchestration degrades to
  `MANUAL_REVIEW`). `LLM_DAILY_SPEND_ALERT_USD` is a monitor surfaced on `/observability/llm`
  and in the alerts roll-up — it **alerts**, it does not block.
- **Replit**: two Reserved VMs (server + agent) are always-on and billed per VM. Size the server
  VM first (it holds api + worker + scheduler); scale up the VM before splitting into more Repls.
- **Upstash + Neon** are the managed add-ons; both have usable free tiers for a single-operator
  pilot. Watch Upstash's daily command cap under sustained load.
- Verify OpenRouter model slugs before the first paid run (§5).

---

## 11. Quick reference — commands

```bash
# One-time, before deploy (from repo root)
npm ci                                 # install workspace deps
npm run typecheck                      # server + web must be clean
npm run scan:secrets                   # no live secrets in tracked files
cd server && npm test                  # server test suite

# Migrations (against a FRESH Neon prod branch)
cd server && npx tsx prisma/apply-all-migrations.ts --dry-run   # preview
cd server && npx tsx prisma/apply-all-migrations.ts             # apply all in order
# one-off single file (late hotfix): npx tsx prisma/apply-migration.ts prisma/migrations/<dir>/migration.sql

# Build for Replit — Server Repl (builds dashboard + server; VITE_OPERATOR_API_KEY at build time)
npm ci
VITE_OPERATOR_API_KEY=<key> npm --workspace @pluvus/web run build   # → web/dist (served by server)
npm --workspace @pluvus/server run build                           # → server/dist
node server/dist/index.js                                          # PROCESS_ROLE=all (single-node)

# Agent (Replit run command)
cd agent && pip install -e ".[ai]" && uvicorn app.main:app --host 0.0.0.0 --port $PORT

# Local full stack (for comparison / staging on one box)
docker compose --profile app up -d --scale worker=3   # api + worker×3 + scheduler×1 + pg + redis
npm run dev                            # non-Docker: server + web together (agent runs separately)
```

---

## 12. Related ops runbooks

| Doc | Covers |
|---|---|
| [`readme_docs/ops/SECRETS.md`](./readme_docs/ops/SECRETS.md) | Full secret inventory + rotation; `npm run scan:secrets` |
| [`readme_docs/ops/STABLE_URL.md`](./readme_docs/ops/STABLE_URL.md) | Public-URL story (interim tunnel vs the stable Reserved-VM host) |
| [`readme_docs/ops/ALERTING.md`](./readme_docs/ops/ALERTING.md) | `/observability/alerts`, log-to-file sink, uptime monitoring |
| [`readme_docs/ops/TEST_DATA_SEPARATION.md`](./readme_docs/ops/TEST_DATA_SEPARATION.md) | Recognizing + purging test data before/after go-live |
| [`.env.example`](./.env.example) | Every env var the code reads, annotated |
| [`docker-compose.yml`](./docker-compose.yml) | The split topology (api / worker / scheduler) — used off-Replit |
