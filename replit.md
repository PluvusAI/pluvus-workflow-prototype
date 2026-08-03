# Pluvus Workflow Platform

An AI-driven creator outreach and workflow automation platform. Three services communicate over well-defined HTTP seams.

## Architecture

| Service | Port | Description |
|---|---|---|
| Web (React/Vite) | 5000 | SPA — builder, wizard, enrollment, monitoring, manual queue |
| Server (Node/TS) | 3001 | REST API, BullMQ workers, scheduler, Drizzle/Postgres |
| Agent (Python/FastAPI) | 8000 | LLM classification, negotiation, email drafting |

Infrastructure: **PostgreSQL** (Replit built-in) + **Redis** (local, started by Backend workflow).

## How to Run

Start workflows in this order:

1. **Backend** — starts Redis (background) + Node server on port 3001
2. **Start application** — starts Vite web app on port 5000 (preview pane)

The agent service is optional. With `AGENT_PROVIDER=mock` and `NEGOTIATION_PROVIDER=mock` the server uses in-process mock providers (no LLM needed). See "Adding real AI" below to enable real LLM calls.

## Environment Variables

Set in Replit Secrets / Env Vars. Key switches:

| Variable | Default | Effect |
|---|---|---|
| `AGENT_PROVIDER` | `mock` | `mock` = in-process, `langgraph` = Python agent |
| `NEGOTIATION_PROVIDER` | `mock` | `mock` = in-process, `langgraph` = Python agent |
| `EMAIL_PROVIDER` | `mock` | `mock` = log-only, `nylas` = real email |
| `REDIS_URL` | `redis://localhost:6379` | Redis for BullMQ queues |
| `DATABASE_URL` | (Replit-managed) | PostgreSQL connection |
| `LLM_PROVIDER` | `mock` | `anthropic` / `deepseek` / `openrouter` / `ollama` |

## Adding Real AI (optional)

To enable real LLM calls:

1. Set `AGENT_PROVIDER=langgraph` and `NEGOTIATION_PROVIDER=langgraph`
2. Set `LLM_PROVIDER=anthropic` (or `openrouter` / `deepseek`)
3. Add the corresponding API key secret (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `DEEPSEEK_API_KEY`)
4. Start the Agent workflow: `cd agent && uvicorn app.main:app --reload --port 8000`
5. Restart the Backend workflow

## Database

- ORM: **Drizzle** (runtime queries) + versioned SQL under `server/prisma/migrations`
- Migrations: with `DATABASE_URL` and `NYLAS_GRANT_ID` set, run
  `cd server && npx tsx prisma/apply-all-migrations.ts`
- Seed demo data: `npm run db:seed:demo -w server`

## Creator CSV Import

Bulk-add creators from the **Enroll** tab: *Upload CSV* → review the preview → *Import*.
Each upload becomes a separate, named list, so today's batch stays distinct from
yesterday's and you can select "only the new ones" when enrolling.

Only an `email` column is required; the delimiter (tab/comma/semicolon) is auto-detected.
Creator-discovery vendor exports work as-is — `platform`, `handle`, and `niche` are
derived from the per-network columns.

**See [docs/csv-creator-import.md](docs/csv-creator-import.md)** for the full column
reference. Templates: `sample-creators.csv`, `sample-creators-vendor.tsv`.

Abandoned DRAFT imports (uploaded but never confirmed) keep their stored file. There is no
automatic sweep yet — if they accumulate, delete drafts via
`DELETE /creators/imports/:id`.

## Useful Commands

```bash
# Run server tests
npm test -w server

# Run engine harness (phase 3)
npm run harness -w server

# Run all harnesses
npm run harness:phase4 -w server  # queues + idempotency
npm run harness:phase5 -w server  # scheduler
npm run harness:phase7 -w server  # classification

# Python agent tests
cd agent && pytest
```

## User Preferences

- Keep `AGENT_PROVIDER=mock` / `EMAIL_PROVIDER=mock` for local dev to avoid LLM costs.
- Redis runs locally (started by the Backend workflow); no external Redis service needed.
