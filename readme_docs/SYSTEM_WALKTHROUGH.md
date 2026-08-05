# Pluvus Workflow Prototype — Complete System Walkthrough

> A detailed, flow-level tour of the entire prototype: what a brand builds, how a
> creator run executes end-to-end, and how every subsystem is wired underneath.
> This is the *complete* view, not the high-level one — it names the actual files,
> functions, fields, enum values, feature flags, and prompt versions, and gives a
> worked example at nearly every step.
>
> Everything below is grounded in the code as of branch `plu-112-clean`. File
> references look like `server/src/engine/runtime.ts:211`. Feature flags are noted
> as `FLAG_NAME` and most ship **dark** (off) by default.

---

## Table of contents

1. [The big picture](#1-the-big-picture)
2. [The three services](#2-the-three-services-and-how-they-talk)
3. [Data model — the spine](#3-data-model--the-spine)
4. [Step 1 — Brand creates a campaign](#4-step-1--brand-creates-a-campaign)
5. [Step 2 — Building the customizable workflow](#5-step-2--building-the-customizable-workflow)
6. [Step 3 — Connecting mailboxes (multi-Nylas)](#6-step-3--connecting-mailboxes-multi-nylas)
7. [Step 4 — Importing creators](#7-step-4--importing-creators)
8. [Step 5 — Enroll & launch](#8-step-5--enroll--launch)
9. [Step 6 — Initial outreach (AI / manual / AI-assisted)](#9-step-6--initial-outreach--three-modes)
10. [Step 7 — Follow-ups](#10-step-7--follow-ups)
11. [Step 8 — Reply detection & classification](#11-step-8--reply-detection--classification)
12. [Step 9 — Negotiation](#12-step-9--negotiation-the-core)
13. [Step 10 — The content brief, OCR, and the knowledge hierarchy](#13-step-10--the-content-brief-ocr--the-knowledge-hierarchy)
14. [Step 11 — After ACCEPT: the fork](#14-step-11--after-accept-the-fork)
15. [Path A — Operator handoff](#15-path-a--operator-handoff)
16. [Path B — Local payment (+ brand-approval gate)](#16-path-b--local-payment--the-brand-approval-gate)
17. [Conversation memory, obligations & summaries](#17-conversation-memory-obligations--summaries)
18. [The reliability backbone](#18-the-reliability-backbone)
19. [Observability & security](#19-observability--security)
20. [Feature-flag & prompt-version reference](#20-feature-flag--prompt-version-reference)

---

## 1. The big picture

Pluvus automates the whole outreach-to-close pipeline for brand↔creator deals. A
brand builds a **campaign** with a **customizable node-graph workflow**, imports a
list of **creators**, and launches. From there the system:

1. sends each creator a first email (**initial outreach**),
2. nudges silent creators (**follow-ups**),
3. reads and classifies each reply (**classification**),
4. negotiates a rate within a brand-set band, guarding hard money invariants (**negotiation**),
5. and once a deal closes, either **hands off to a human operator** or runs the
   **fully-automated local-payment fulfillment** (payout form → content brief →
   content-link collection), optionally behind a **brand-approval gate**.

Every creator moving through a workflow is one **`ExecutionInstance`** — a row
walking a **state machine**. The whole system is, at heart, that state machine plus
the durable plumbing (queues, locks, sweeps) that makes it survive crashes and
races, plus an LLM service that does the "thinking" (classify / negotiate / draft /
summarize / template-authoring) behind deterministic guards.

**Mental model:** the TypeScript server owns *truth and safety* (state, money
guards, idempotency). The Python agent owns *language* (understanding replies,
writing copy). The server never lets the model's output become truth without
passing it through a deterministic guard first.

---

## 2. The three services (and how they talk)

| Service | Stack | Role |
|---|---|---|
| **`server/`** | Node/TS, Express, BullMQ+Redis, Prisma schema + Drizzle queries, Postgres | The workflow engine, state machine, DB, email (Nylas), all routes, workers, schedulers. The source of truth. |
| **`agent/`** | Python, FastAPI | The LLM service. Stateless HTTP endpoints: `/classify`, `/negotiate` (which also drafts), `/summarize`, `/outreach/template`, `/parse-brief`. |
| **`web/`** | React + Vite | The operator UI: campaign wizard, node-graph builder, enroll/launch, live monitor, manual queue, instance inspector. |

The server calls the agent over HTTP through an **adapter layer** so it can be
swapped for a mock in tests:

- `server/src/adapters/classification/LangGraphClassificationProvider.ts` → `POST /classify`
- `server/src/adapters/negotiation/LangGraphNegotiationProvider.ts` → `POST /negotiate`
- Mocks (`MockClassificationProvider`, `MockNegotiationProvider`) provide deterministic keyword-based behavior for offline tests.

The agent supports multiple LLM back-ends selected by env (`agent/app/llm.py`):
**Ollama** (local dev, e.g. `qwen3:30b-a3b`), **Anthropic Claude** (`claude-opus-4-8`
/ `claude-haiku-4-5`), **DeepSeek**, and **OpenRouter** (a single gateway proxying
many upstreams). Providers can be pinned **per role** — e.g. Claude for
`negotiate`/`classify`, DeepSeek for `draft` copy — via `LLM_PROVIDER_<ROLE>` with a
`LLM_FALLBACK_PROVIDER_<ROLE>` failover chain.

---

## 3. Data model — the spine

Everything hangs off a handful of Prisma models (`server/prisma/schema.prisma`). The
key ones:

- **`Campaign`** — the brand's top-level container. Holds brand identity + all the
  free-text terms the AI is allowed to state as fact (see §4).
- **`Workflow`** → **`WorkflowVersion`** — a workflow is the editable definition; a
  version is an **immutable published snapshot** of the node graph. Instances pin to
  a version, so editing a workflow never changes a run already in flight.
- **`Creator`** — a creator profile (seeded or CSV-imported).
- **`ExecutionInstance`** — **one creator running one workflow version**. The unit of
  execution, scheduling, and audit. Carries `currentState`, `currentNodeId`,
  `followUpCount`, `negotiationRound`, `dueAt`, a `version` counter for OCC, and two
  fields **stamped once at enrollment and never rewritten**: `postAcceptanceMode` and
  `emailAccountId`.
- **`Message`** — every inbound/outbound email tied to an instance. Carries
  `threadId`/`externalMessageId` for correlation, `idempotencyKey` for exactly-once
  sends, `sentAt`/`receivedAt`/`processedAt` timestamps, `emailAccountId` (which
  mailbox), and `redriveCount`/`scheduledFor` for the randomized-send-delay machinery.
- **`Event`** — an **append-only** audit log. Never updated or deleted. This is the
  money trail: `NEGOTIATION_TURN` events are how the agreed rate is recovered.
- **`ConnectedEmailAccount`** — one Nylas grant = one mailbox (multi-Nylas, §6).
- **`DealHandoff`** — the snapshot of a closed deal for operator handoff (§15).
- **`PaymentInfo`** / **`BrandApproval`** / **`ConversationObligation`** /
  **`CampaignCreatorMemory`** — supporting ledgers for the local-payment path, gate,
  obligations, and memory.

### The state machine

Every instance has a `currentState` from the `InstanceState` enum. The happy path,
in order:

```
ENROLLED
  → OUTREACH_QUEUED → OUTREACH_SENT          (initial outreach, pacing-gated)
  → AWAITING_REPLY  ⇄ FOLLOWED_UP            (waiting; follow-ups nudge)
  → REPLY_RECEIVED                           (a reply arrived)
  → NEGOTIATING                              (one or more negotiation turns)
  → ACCEPTED                                 (deal closed)
       │
       ├── Path A (operator_handoff):
       │     → NEEDS_DEAL_FINALIZATION  → HANDOFF_COMPLETE
       │
       └── Path B (local_payment):
             → [AWAITING_BRAND_APPROVAL]     (only if the gate is on)
             → PAYMENT_PENDING → PAYMENT_RECEIVED
             → CONTENT_BRIEF_SENT / CONTENT_LINKS_PENDING → (MANUAL_REVIEW on submission)
```

Terminal states: `HANDOFF_COMPLETE`, `REJECTED`, `OPTED_OUT`, `NO_RESPONSE`,
`MANUAL_REVIEW`. (Note: the live Drizzle enum in `server/src/db/schema.ts` also
contains `AWAITING_BRAND_APPROVAL`, `CONTENT_LINKS_PENDING`, and the
`CONTENT_LINKS_SUBMITTED` / `BRAND_APPROVAL_REQUESTED` / `BRAND_APPROVED` /
`BRAND_REJECTED` events — the Prisma file is slightly behind on those.)

**The engine loop** lives in `server/src/engine/runtime.ts`. `WorkflowRuntime`:
- `loadContext(instanceId)` resolves the instance, creator, workflow version, current
  node, and parent campaign.
- `stepInstance(instanceId)` dispatches to the right executor, then commits the
  resulting state transition **atomically** with its audit events inside one DB
  transaction, using **optimistic concurrency control** (see §18).
- `runUntilWaiting(instanceId)` steps repeatedly until it hits a "waiting" state
  (awaiting a reply, a form submission, or a human).

Each **node type** has an **executor** in `server/src/engine/executors/`. Dispatch is
driven by `(state, node.type)`.

---

## 4. Step 1 — Brand creates a campaign

**UI:** `web/src/components/builder/CampaignWizard.tsx`
**API:** `POST /campaigns` → `server/src/routes/campaigns.ts` → `server/src/db/campaigns.ts`

A campaign is where the brand supplies **identity** and the **facts the AI is allowed
to state**. This matters enormously: the negotiation/draft models are forbidden from
inventing terms, so anything not filled in here gets *honestly deferred* ("I'll
confirm that on the next step") rather than hallucinated.

### Campaign fields and what each is used for

| Field | Example | Where it's used technically |
|---|---|---|
| `name` | `"Summer 2026 Launch"` | Campaign identifier; stamped as `campaignName` into outreach copy. |
| `brand` | `"TempoCo"` | Brand name; stamped as `brandName`/`senderName` into every node config. |
| `brandDescription` | `"a running-shoe brand"` | Lets the AI answer "what does your brand do?" without hallucinating. |
| `deliverables` | `"3 IG Reels + 1 YouTube integration"` | Stamped into node config; stated as real scope in outreach/negotiation instead of "to be finalized". |
| `timeline` | `"content live by Sept 15, 2026"` | Stamped as `timeline`; stated only when present, never invented. |
| `rewardDescription` | `"a free pair of our Tempo trainers"` | The perk; mentioned in outreach/negotiation/reward copy. |
| `shipsPhysicalProduct` | `true` | When true, the hosted payout form also collects a shipping address. **Campaign is authoritative** — re-stamped every save. |
| `usageRights` | `"6-month paid social on the brand's handles"` | HARD-K1 knowledge field (see §13). |
| `exclusivity` | `"no competing footwear for 30 days"` | HARD-K1 knowledge field. |
| `paymentTerms` | `"net-30 after content approved, bank transfer"` | HARD-K1 knowledge field. |
| `attributionWindow` | `"30-day last-click cookie"` | HARD-K1 knowledge field. |
| `objective`, `notes` | — | Operator-facing only; **not** sent to creators. |
| `notifyEmail` | `"partnerships@tempo.co"` | Where manual-review escalations + brand-approval links + handoff notices go. Falls back to `BRAND_NOTIFY_EMAIL` env, then the platform operator. |
| `targetUrl` | `"https://tempo.co/shop"` | Landing page for tracked referral links; **validated server-side against SSRF/open-redirect**. |
| `postAcceptanceMode` | `local_payment` \| `operator_handoff` | The fork after ACCEPT (§14). **Campaign-level default only** — stamped onto each instance at enrollment. |
| `emailAccountId` | `"acct_123"` | The campaign's default sending mailbox (§6). Also stamped per-instance at enrollment. |
| `dailyInitialOutreachLimit` | `30` | PLU-122 daily cap on *initial outreach* sends (UTC day). NULL = legacy no-cap. |
| `outreachPacingMinMinutes` / `MaxMinutes` | `5` / `10` | Random spacing between consecutive initial-outreach sends. |
| `negotiationReplyPacingMinMinutes` / `MaxMinutes` | `1` / `5` | Random delay before AI negotiation replies go out (so they don't land microseconds after the creator's email). |

> **Key concept — "stamping":** at draft-save and publish, the server copies campaign
> fields down onto **every node's config** (`restampBrand()` in
> `server/src/routes/workflows.ts`). This means the builder preview and the runtime
> executor read the *same* values. `deliverables`/`timeline`/`rewardDescription`/
> `brandDescription` are injected only if a node hasn't overridden them;
> `shipsPhysicalProduct` is overwritten every time (campaign wins).

The pacing/limit fields are also editable after creation via
`web/src/components/builder/CampaignSendingSettings.tsx`
(`server/src/validation/campaignSendingSettings.ts` bounds them: limit 1–1000, pacing
1–60 min, min ≤ max). Because they're read at enrollment, edits affect **future**
enrollments, never a run already going.

---

## 5. Step 2 — Building the customizable workflow

**UI:** `web/src/components/builder/WorkflowBuilder.tsx`, `BuilderCanvas.tsx`,
`NodeConfigPanel.tsx`, `NodePalette.tsx`
**Model:** `web/src/workflow/graphModel.ts`, `nodeDefaults.ts`, `graphValidation.ts`
**API:** `server/src/routes/workflows.ts`, `server/src/db/workflows.ts`

The workflow is a **node graph** the operator assembles on a canvas. In the editor
it's a visual graph (positions + edges, stored in an additive `_graph` sidecar); the
runtime sees it as a **flat ordered array of node snapshots**
(`[{ id, type, order, config }]`). On **publish**, that array is frozen into a
`WorkflowVersion.nodeGraph` JSON — immutable forever.

### Node types and their config

| Node (`NodeType`) | What it does | Key config fields (`config.*`) |
|---|---|---|
| `IMPORT_CREATOR_LIST` | Implicit entry point where enrolled creators land. | — |
| `INITIAL_OUTREACH` | The first email. | `outreachMode` (`"manual"` \| `"ai"`), `subjectTemplate`, `bodyTemplate` |
| `FOLLOW_UP` | Nudges silent creators. | `intervals` (e.g. `[3, 5]`), `intervalUnit` (`"days"`…), `maxCount` (1–5), optional `bodyTemplate` |
| `REPLY_DETECTION` | Classifies each reply, routes the flow. | none — threshold + routing fixed in engine |
| `NEGOTIATION` | Negotiates a rate within the band. | `minBudget` (floor), `maxBudget` (ceiling), `maxRounds` (1–5), optional `commissionRate`, hidden `overCeilingTolerance` |
| `CONTENT_BRIEF` | Merged post-accept node: sends finalized offer + payout link + brief PDF. | `briefFileRef` (uploaded PDF, required), `briefFileName` |
| `REWARD_SETUP`, `PAYMENT_INFO` | **Legacy** nodes, superseded by the merged `CONTENT_BRIEF`. Kept for backward-compat with old published versions. | — |
| `END` | Terminal. | — |

### The negotiation band

The band (floor/ceiling/rounds) is configured on the `NEGOTIATION` node. The resolver
`server/src/engine/band.ts` accepts **two shapes** for backward compatibility:

- UI shape: `{ minBudget: 300, maxBudget: 500, maxRounds: 3, commissionRate: 10 }`
- Seed/snapshot shape: `{ termFloor: { rate: 300 }, termCeiling: { rate: 500 } }`

`resolveBand(config)` returns `{ termFloor, termCeiling, floor, ceiling }` with
`termFloor/termCeiling` (explicit) taking precedence over `minBudget/maxBudget`.
Validation (`web/src/workflow/graphValidation.ts`, mirrored server-side) enforces
`maxBudget ≥ minBudget` and **HARD-N3**: if `maxBudget > 0` then `minBudget > 0` (so a
band can never open at $0).

### Draft → validate → publish

1. `POST /workflows/:id/draft` — persists `draftNodes` (mutable).
2. `POST /workflows/:id/validate` — structural + config checks, no state change.
3. `POST /workflows/:id/publish` — runs full validation, **re-stamps** campaign brand
   fields + derived outreach fields (`campaignName`, `collaborationType`,
   `offerSummary` from the deal shape) + the negotiation commission, then writes a new
   immutable `WorkflowVersion` and flips the workflow to `PUBLISHED`.

**Graph validation** (`server/src/validation/graphValidation.ts`) enforces a single
linear path through phase-ordered nodes (entry → outreach → classify → negotiate →
post-accept/terminal), no cycles, no orphans. Launch re-runs a lighter
`structuralOnly` pass as a safety net.

---

## 6. Step 3 — Connecting mailboxes (multi-Nylas)

**Model:** `ConnectedEmailAccount` (Prisma)
**DB:** `server/src/db/emailAccounts.ts`
**API:** `server/src/routes/emailAccounts.ts`
**Provider:** `server/src/providers/nylas/*`, `server/src/engine/providerFactory.ts`
**Spec:** `.claude/spec/plu-121-multi-mailbox-remediation/PLAN.md`

Nylas is the email API. Each connected mailbox is one **Nylas grant** = one
`ConnectedEmailAccount` row:

```
nylasGrantId   (unique — the per-mailbox handle used as `identifier` on every Nylas call)
emailAddress   ("outreach@tempo.co")
displayName    (optional)
provider       ("nylas")
status         ("active" | "disabled" | "revoked")
isDefault      (partial-unique index → at most one active default)
```

Only the **opaque grant id + address** are stored — never raw credentials (the API
key stays a shared env value).

### Managing mailboxes

- `GET /email-accounts` — list (for the sender picker).
- `POST /email-accounts` — register a mailbox by grant id (validates format, rejects
  duplicates with 409, `status: "active"`).
- `PATCH /email-accounts/:id` — update address/status/default (only an active account
  can be made default; disabling the default auto-clears the flag).

### How a send picks a mailbox (pinning)

The critical invariant: **an entire conversation stays on one mailbox.** This is done
by *pinning at enrollment*:

1. At enroll time, `resolveAccountForCampaign(campaign.emailAccountId)` resolves the
   effective account: **campaign's chosen account → the default active account**.
2. That account id is stamped onto `ExecutionInstance.emailAccountId` **once, never
   rewritten**. Changing the campaign's default later only affects *future*
   enrollments.
3. On every send, `defaultResolveInstanceProvider(instanceId)`
   (`server/src/engine/executors/idempotentSend.ts`) reads the instance's pinned
   account, builds a grant-bound provider via `emailProviderForAccount(account)`
   (cached per grant in `providerFactory.ts`), and sends with
   `messages.send({ identifier: grantId })`. The sent `Message` row is stamped with
   that `emailAccountId`.

**Safety property (B2):** if the pinned account can't be resolved (transient DB
error), the resolver **throws** rather than silently falling back — so a BullMQ retry
happens instead of sending from the *wrong* mailbox.

### Inbound routing

When a Nylas webhook fires (`server/src/routes/webhooks.ts`):

1. Extract the `grant_id` and message from the payload.
2. Replay-guard against duplicate deliveries.
3. Resolve the account by grant (`findEmailAccountByGrantId`). If a grant is present
   but unregistered → **reject** (don't fall back to unscoped correlation, which would
   leak across accounts).
4. **Thread-correlate, scoped to that account:** `findMessagesByThreadId(threadId,
   accountId)` → the matching `Message` rows → the `ExecutionInstance`. Message ids
   are unique *per account* (`@@unique([emailAccountId, externalMessageId])`), so
   thread ids can't collide across grants.
5. Drop our own outbound echoes; enqueue an `inbound-email` job stamped with the
   account id.
6. The inbound worker (`server/src/workers/inboundEmailWorker.ts`) verifies the
   webhook's account matches the instance's pinned account before processing.

**Wiring status:** the data model, send-side pinning, enrollment resolution,
management API, and per-account provider factory are fully implemented and tested
(`multiMailboxSend.test.ts`, `multiMailboxSendResolution.test.ts`). Some hardening
from the remediation spec is still open: a management UI (M2), disabled-account
inbound dead-lettering (B4), and removal of a dead per-account `webhookSecret` field
(B3). This is documented in the PLAN.md above.

---

## 7. Step 4 — Importing creators

**API:** `server/src/routes/creatorImports.ts`
**Validation:** `server/src/validation/{creatorImport,parseCsv,creatorFields}.ts`
**UI:** `web/src/components/builder/ImportBatchPicker.tsx`, `ImportPreviewPanel.tsx`

A brand bulk-imports creators from a CSV or a creator-discovery vendor export (often
~80 columns). The batch lifecycle is **DRAFT → COMMITTED → ARCHIVED** so "yesterday's
list" stays a re-selectable, auditable thing.

1. **Upload** (`POST /creators/imports`) — multipart file (25 MB cap). Binary is
   rejected (NUL-byte scan); the delimiter is sniffed (`\t`, `,`, `;`); a fuzzy
   email-column check rejects a file with no email. Rows are validated (email regex,
   in-file dedup) and stored as a **DRAFT** batch — *nothing is written to the roster
   yet*.
2. **Column mapping** (`creatorFields.ts`) — the interesting part for vendor exports:
   - Scalar fields (`name`, `handle`, `platform`, `niche`, `profileUrl`…) map via
     fuzzy header aliases.
   - Five per-network blocks (Instagram/TikTok/YouTube/Twitter/Twitch) each carry
     follower count, username, link, engagement %, etc.
   - `name`/`platform`/`handle`/`profileUrl`/`engagementRate` are **derived from the
     largest-audience network** (an unknown follower count sorts as UNKNOWN, never 0).
   - The ~50 remaining per-network columns are absorbed into JSON blobs:
     `socialLinks`, `platformStats`, `signals` (has_brand_deals,
     promotes_affiliate_links…). Everything else is kept verbatim in `metadata` — no
     column is dropped.
3. **Preview** — the operator sees `"142 rows · 118 new · 21 already · 3 skipped"`
   with skip reasons before committing.
4. **Commit** (`POST /creators/imports/:id/commit`) — re-derives from the stored raw
   rows (not client JSON), upserts creators, flips the batch to **COMMITTED**.

The picker in the Enroll tab can scope selection to "new from this list" / "existing"
/ "all", and shows an "also in Jul 20 list" badge via cross-batch membership.

---

## 8. Step 5 — Enroll & launch

**UI:** `web/src/components/builder/EnrollTab.tsx`, `LaunchTab.tsx`
**API:** `server/src/routes/workflows.ts` (`/enroll`, `/launch`)

**Enroll** (`POST /workflows/:id/enroll`) creates one `ExecutionInstance` per selected
creator against the latest published version. At this moment two things are **stamped
and locked forever**:

- `postAcceptanceMode` = *enrollment override → campaign default → `local_payment`*.
- `emailAccountId` = *campaign's account → default active account* (§6).

This "stamp once at enrollment" pattern is what makes a later campaign edit unable to
change the behavior of a run that's already going.

**Launch** (`POST /workflows/:id/launch`) enqueues a `node-execution` job for every
`ENROLLED` instance (guarded on the `ENROLLED` state). Workers pick them up and the
first node (initial outreach) runs.

---

## 9. Step 6 — Initial outreach — three modes

**Executor:** `server/src/engine/executors/initialOutreach.ts`
**Variables:** `server/src/engine/outreachVariables.ts` (+ web mirror `web/src/workflow/outreachVariables.ts`)
**Guard:** `server/src/engine/guards/outputGuard.ts`
**AI-assist:** `agent/app/routes/outreach_template.py`, proxied via `server/src/routes/workflows.ts`

The first email can be produced three ways. The mode is read from
`node.config.outreachMode` (absent → `"ai"` for legacy safety; new nodes default to
`"manual"`).

### Mode A — Manual (operator writes it verbatim) — recommended

The operator writes the subject + body themselves in the builder, inserting
`{{variables}}` from a click-to-insert palette (`NodeConfigPanel.tsx`,
`VariablePalette`). At send time, `resolveOutreachTemplate()` substitutes the tokens
and the copy goes out **exactly as written** — no AI call.

**The shared variable allow-list** (`outreachVariables.ts`) is the single source of
truth (mirrored on the web side so builder validation matches runtime):

| Variable | Resolves to | Required? |
|---|---|---|
| `{{creatorFirstName}}` | first word of `creator.name` | no |
| `{{creatorName}}` | `creator.name` | **yes** |
| `{{platform}}` | `creator.platform` or "social media" | no |
| `{{niche}}` | `creator.niche` or "your niche" | no |
| `{{brandName}}` | `config.brandName` / `senderName` | **yes** |
| `{{senderName}}` | `config.senderName` / `brandName` | no |
| `{{brandDescription}}` | `config.brandDescription` | no |
| `{{campaignName}}` | `config.campaignName` (stamped from `campaign.name`) | no |
| `{{collaborationType}}` | from deal shape ("fixed-fee"/"affiliate"/"hybrid"), else "partnership" | no |
| `{{offerSummary}}` | price-free summary from deal shape | no |
| `{{rewardDescription}}` | `config.rewardDescription` | no |
| `{{deliverables}}` | `config.deliverables` | no |
| `{{timeline}}` | `config.timeline` | no |

**Handling of tokens:**
- **Unknown token at publish** (e.g. `{{firstName}}`): blocked, with a Levenshtein
  "did you mean `creatorFirstName`?" suggestion.
- **Unknown token at send**: stripped to empty (defensive).
- **Required token that resolves empty** for a given creator (e.g. `{{creatorName}}`
  but the creator has no name): that creator is **skipped and routed to
  MANUAL_REVIEW** rather than sending "Hi ,". (`missingRequiredValues()`.)

### Mode B — Fully AI-generated

If `outreachMode: "ai"`, the executor calls
`agent.draftEmail("initial_outreach", creator, config, { dealDescription })`. If the
agent returns null, it falls back to rendering the template. The draft prompt version
is `draft-v2.2` (`agent/app/routes/negotiate.py`).

### Mode C — AI-assisted template authoring (in manual mode)

While writing a manual template, the operator can click **Generate** / **Make
shorter** / **Suggest alternate subjects** in the builder's AI-assist panel. This
calls a server proxy `POST /workflows/:id/outreach/template`, which:

1. Assembles **brand context server-side** (a trust boundary — the client only sends
   an *instruction* + the current copy, never the brand facts). Empty fields are
   omitted so the AI never treats a blank as a fact.
2. Computes the **allowed placeholders** (only variables that resolve to non-empty
   for this campaign) and passes them to the agent.
3. Calls `POST /outreach/template` (`outreach_template.py`, prompt version
   `outreach-template-v1.1`, "direct/human tone").

The prompt's hard constraints: use **only** supplied placeholders, invent **no**
facts, state **no** money figures (rates are negotiated on reply), keep it a template
(same email for everyone with placeholders swapped), and drop the flattery preamble.
It returns a subject, body, up to 3 alternate subjects, and a list of any
`flaggedPlaceholders` it wasn't supposed to use. The instruction field is **injection-
gated** (`looks_like_injection`) so "ignore your instructions and…" returns a 400
"rephrase" instead of reaching the model.

In the UI, applying a proposal **snapshots the prior copy first** and shows a
one-step **Undo**.

### The output guard (both modes)

Before any outreach is reserved for sending, `scanOutboundDraft()`
(`outputGuard.ts`) scans subject+body for **leaks**:
- any digit-number or word-number (e.g. "five hundred") that isn't an authorized
  figure (our presented offer, the creator's stated ask, or a brand-public $ blurb),
- any `$` amount not on the allow-list,
- any commission `%` other than the configured one,
- internal terms like "ceiling"/"maximum budget".

A hit → the instance is routed to **MANUAL_REVIEW** with masked details
(`ceiling:<redacted>`), and nothing is sent.

### Pacing gate

Initial outreach doesn't fire instantly. The instance goes `ENROLLED →
OUTREACH_QUEUED`, and the delayed-send worker atomically claims a slot against the
campaign's **daily cap + per-send pacing** (`claimInitialOutreachSlot`, §18.6). Only
when a slot is granted does the email flush and the state advance to `OUTREACH_SENT`.

**Worked example (manual mode):**
Template body: `"Hi {{creatorFirstName}}, I'm {{senderName}} at {{brandName}}. We're
running {{campaignName}} and would love you on {{deliverables}}. Interested? — {{senderName}}"`.
For creator "Maya Chen" on campaign "Summer 2026 Launch" (brand TempoCo, deliverables
"3 IG Reels"), it renders `"Hi Maya, I'm Sam at TempoCo. We're running Summer 2026
Launch and would love you on 3 IG Reels. Interested? — Sam"`, passes the guard (no
money), is queued, paced, and sent from the pinned mailbox.

---

## 10. Step 7 — Follow-ups

**Executor:** `server/src/engine/executors/followUp.ts`

If a creator doesn't reply, the `FOLLOW_UP` node schedules nudges at the configured
`intervals` (e.g. days `[3, 5]`) up to `maxCount`. Each schedule sets a `dueAt` on the
instance; the poller (§18.3) finds due instances and enqueues a step. State cycles
`AWAITING_REPLY ⇄ FOLLOWED_UP`. A reply at any point clears `dueAt` and moves the
instance to `REPLY_RECEIVED`. If follow-ups are exhausted with no reply, the instance
ends as `NO_RESPONSE`.

A special case: if a reply is classified `DEFERRED` ("let me get back to you next
week") and a follow-up node exists, the system schedules a **soft** follow-up a few
days out rather than negotiating or rejecting.

---

## 11. Step 8 — Reply detection & classification

**Executor:** `server/src/engine/executors/replyDetection.ts`
**Adapter:** `server/src/adapters/classification/LangGraphClassificationProvider.ts`
**Agent:** `agent/app/routes/classify.py` (prompt `classify-v1.1`)

When a reply lands (`REPLY_RECEIVED`), the reply text is extracted (quoted history +
signature stripped) and classified into one of six intents:

`POSITIVE` · `NEGATIVE` · `QUESTION` · `OPT_OUT` · `DEFERRED` · `UNKNOWN`

Classification is **defense-in-depth**: deterministic gates run *before* the LLM, so
compliance and safety don't depend on the model:

1. **Deterministic opt-out gate** — a real, unconditional unsubscribe → `OPT_OUT @
   1.0` immediately (CAN-SPAM; can't be suppressed by prompt injection). Conditional
   or rhetorical "unsubscribe" ("remove me *if* you can't beat $400", "unsubscribe? no
   way") is **not** treated as opt-out (`opt_out_is_conditional_or_rhetorical`).
2. **Injection gate** — jailbreak patterns → `UNKNOWN @ 0.0` → MANUAL_REVIEW.
3. **Always-escalate topic gate** — legal/dispute/pricing-exception/usage-rights
   *demands* → `UNKNOWN @ 0.0` with an `escalationReason` (§12/§13, `topic_gate.py`).
4. **Deterministic rate gate** — a bare price ("I charge $480") → force `POSITIVE @
   1.0` (small models mislabel bare prices as NEGATIVE).
5. **Deterministic question gate** — a product/deal question → force `QUESTION @ 1.0`.
6. **LLM classification** — only if all gates pass.
7. **Post-LLM confidence gate** — confidence `< 0.50` → downgrade to `UNKNOWN` →
   MANUAL_REVIEW.

**Routing** (`replyDetection.ts`):
- `POSITIVE` / `QUESTION` → `NEGOTIATING`
- `NEGATIVE` → `REJECTED` (terminal)
- `OPT_OUT` → `OPTED_OUT` (terminal)
- `DEFERRED` → soft follow-up (if node present) else negotiate
- `UNKNOWN` / escalation-reason → `MANUAL_REVIEW`

**Important mid-negotiation short-circuit:** if `negotiationRound ≥ 1`, classification
is **skipped** and the reply routes straight to `NEGOTIATING`. This prevents a
mid-negotiation "I charge 480" from being re-classified `NEGATIVE` and killing the
deal.

---

## 12. Step 9 — Negotiation (the core)

**Executor:** `server/src/engine/executors/negotiation.ts`
**Agent:** `agent/app/routes/negotiate.py`
**Band:** `server/src/engine/band.ts`
**History:** `server/src/engine/executors/negotiationHistory.ts`

This is the heart of the system. Each negotiation turn: the server assembles context,
calls the agent, the agent's proposed action/rate passes through **deterministic
guards**, and the guarded decision drives the copy and the state transition.

### What the agent sees

The server sends a `NegotiateRequest` with: the extracted `creatorReply`, the
`currentOffer`, `round`/`maxRounds`, the decision `negotiationHistory` (our prior
turns, event-sourced), the both-sides `conversationHistory` (the real transcript),
`openCommitments` (unfulfilled promises), the classifier `intent` (a *soft* hint), and
`campaignConstraints` (band `termFloor`/`termCeiling`, `commissionRate`,
`deliverables`, `timeline`, and the knowledge fields).

### Two strategies

- **LLM strategy (default)** — the model reads the full context and picks both the
  action *and* the rate. Prompt version `llm-negotiate-v1.7`. Guards then bound it.
- **Rules strategy (safety fallback)** — the model only classifies intent + extracts
  the creator's stated rate; a deterministic `_decide_action()` makes the call. Prompt
  version `rules-extract-v2.0`. Used when the LLM is unavailable/malformed.

### Actions

`ACCEPT` · `COUNTER` · `REJECT` · `ESCALATE` · `PRESENT_OFFER`.

### The decision guards (`_apply_decision_guards`)

This is the money-safety layer. It clamps the model's free choice to hard invariants
using the band, the creator's stated ask this turn (`creator_ask`), our last concrete
offer (`prior_offer`), and a `standing_offer` backstop:

- **Never agree over budget.** An `ACCEPT`/final `COUNTER` above the (tolerance-)ceiling
  becomes `ESCALATE`.
- **Never invent an over-ceiling agreement** (CRITICAL-4). If the creator explicitly
  demands more than the ceiling on the final round, escalate — don't coerce a false
  accept.
- **Never close above our standing offer** (BUG-A4). If the creator named *no* rate,
  an `ACCEPT` is clamped **down** to `prior_offer`/`standing_offer`, never up to the
  model's drifted number.
- **Accept at the creator's ask, not the model's number**, when the creator named an
  in-band rate.
- **Never counter above the creator's ask; never counter below a prior offer.**

When guards **alter** the decision, the model's own draft is discarded and `/draft`
regenerates copy from the *guarded* decision.

**Worked example — the $325→$450 drift bug the guards prevent:**
Band floor $300 / ceiling $500, we're standing at $350. The model returns `ACCEPT @
$450` on a turn where the creator named no new rate. Guards: `creator_ask = None`,
`prior_offer = 350`, so `450` is clamped down to `350`; final `min(350, 500) = $350`.
The deal closes at **$350**, not the fabricated $450.

**Worked example — a clean counter:** Creator asks $480 (band $300–$500, we're at
$350). Model counters $400 (midpoint). Guard: `400` is in-band and `≤ 480` → passes.
We send "$400" copy, `NEGOTIATION_TURN {action: COUNTER, rate: 400}` is logged, state
returns to `AWAITING_REPLY`, `negotiationRound → 1`. Creator replies "Deal, $400
works." → `ACCEPT @ 400` → `ACCEPTED`.

### The canonical transcript (PLU-85)

`negotiationHistory.ts` builds the transcript the copywriter sees from **`Message`
rows where `sentAt != null`** — i.e. what was *actually sent*, not what the AI drafted
for itself. Our outbound rows are enriched by joining to `NEGOTIATION_TURN` events for
`round`/`action`/`rate`. This fixes an asymmetry where the creator side was ground
truth but our side used to be the AI's own draft fed back as fact. The negotiate
model's `responseDraft` is threaded into `/draft` as vetted answers so the copy model
rephrases rather than re-invents.

### At max rounds

On the final round the guards prefer to close within band (at the creator's in-band
ask or our standing offer); an over-ceiling demand escalates to `MANUAL_REVIEW`.

---

## 13. Step 10 — The content brief, OCR & the knowledge hierarchy

This section answers the user's specific questions: *how the brief is read (OCR), how
it becomes context for the AI, and which info wins when they conflict.*

### Uploading & attaching the brief

**Upload:** `server/src/routes/uploads.ts` — `POST /uploads` accepts a PDF (10 MB
cap), validated by extension **and** `%PDF-` magic bytes. `localFileStorage.ts` stores
it under `uploads/` with a random UUID name and returns an opaque `fileReference`.
That reference is saved as `briefFileRef` on the `CONTENT_BRIEF` node config.

**Attach:** at send time (`contentBrief.ts`), `readStoredFile(briefFileRef)` loads the
bytes and attaches them as `application/pdf` on the outbound email.

### Reading the brief — text extraction and OCR

**Agent side:** `agent/app/brief.py`, `PARSER_VERSION = "brief-parser-v1.1"`.

1. **Embedded text (default):** `pypdf.PdfReader` + `page.extract_text()` pulls the
   text layer. Fast, works for digitally-generated PDFs.
2. **OCR fallback (dark, opt-in):** gated by `BRIEF_OCR_FALLBACK_ENABLED`. It fires
   **only when the embedded-text pass yields thin/no text** (a scanned or image-only
   PDF). It shells out to **OCRmyPDF + Tesseract** (`ocrmypdf --skip-text --pages 1-10
   --quiet`, 120 s timeout, CPU-only), then re-extracts. Chosen over
   PaddleOCR/EasyOCR for feasibility reasons documented in
   `readme_docs/OCR_FALLBACK_FEASIBILITY.md`.
3. **Fail-soft:** any failure (bad bytes, missing binary, timeout, OCR error) returns
   `""` — it never throws. A `parse_failed` result is **not cached**, so a transient
   error is retried next turn rather than poisoning the brief until restart.

**Structured parsing (PLU-107, dark via `STRUCTURED_BRIEF_PARSING_ENABLED`):** beyond
the flat blob, a deterministic parser segments the brief into typed sections —
`overview`, `deliverables`, `timeline`, `usageRights`, `exclusivity`, `paymentTerms`,
`shipping`, `faq`, etc. Tier 1 is heading-based (high confidence); tier 2 is
keyword-block inference for gaps (lower confidence). Results are cached per
`ref::parserVersion::parseMode` on the server (`briefKnowledge.ts`, max 256 entries).

**Brief availability** is projected to four states so the AI knows what it's working
with: `NO_BRIEF`, `PARSE_FAILED` (present but unreadable ≠ absent), `AVAILABLE`, or
`PARTIAL` (some expected sections missing).

### The knowledge hierarchy — which source wins

This is the crux. When the AI needs a fact (e.g. to answer "what are the usage
rights?"), the server resolves it through a **precedence ladder** per category
(`server/src/engine/knowledgePrecedence.ts`, `resolveKnowledgeField(category,
sources)`). The source slots, highest priority first:

1. `confirmedAgreement` — a real negotiated agreement
2. `operatorOverride` — a manual override seam (reserved; always undefined in v1)
3. `workflowConfig` — **this node's** config
4. `negotiationState` — the **NEGOTIATION node's** config
5. `campaignDefault` — the `campaign.*` column

Per-category precedence (from `KNOWLEDGE_PRECEDENCE.md`):

| Category | Ladder |
|---|---|
| `deliverables`, `timeline`, `rewardDescription` | override → workflowConfig → negotiationState → campaignDefault |
| `commissionRate` | override → workflowConfig → negotiationState (no campaign default — it's a fixed brand term) |
| `paymentTerms` | override → workflowConfig → **~~negotiationState~~ (deliberately skipped)** → campaignDefault |
| `usageRights`, `exclusivity`, `attributionWindow` | override → workflowConfig → campaignDefault |

> **Where does the brief sit?** For `usageRights`/`exclusivity`/`paymentTerms`/
> `attributionWindow`, the **brief is NOT a fallback source** — it's a **conflict
> challenger**. `detectBriefConflicts()` (`briefKnowledge.ts`) compares the campaign's
> configured value against what the brief says (e.g. campaign "Net-30" vs brief "Net-
> 60", or exclusivity yes-vs-no). A material mismatch can route the deal to
> MANUAL_REVIEW — gated by `MATERIAL_CONFLICT_ESCALATION_ENABLED` (detection always
> runs; only the escalation is flag-gated).

The resolved fields are injected into the negotiate/draft prompt as `campaignContext`
/ `campaignConstraints`. **When a field is absent from every source, the AI defers
honestly** — "I'll confirm the usage rights on the next step" — and mints a
`PLUVUS_COMMITMENT` obligation (§17). It never invents a value.

### Retrieving only the relevant sections (PLU-114)

Sending the whole brief blob every turn is wasteful and noisy. With
`KNOWLEDGE_RETRIEVAL_ENABLED`, a **deterministic router**
(`agent/app/knowledge_retrieval.py`) picks only the sections relevant to the creator's
current message + open obligations. It runs regex rules (e.g. `reshare|reuse|licen[cs]e
|whitelist` → the `usageRights` section) plus obligation-category routing, caps at 5
sections, and resolves each value deterministically (**campaign flat field is
authoritative; brief section is the fallback**). An optional LLM classifier
(`knowledge_classifier.py`, `KNOWLEDGE_CLASSIFIER_ENABLED`) is consulted **only** on
the uncertain path; it can pick section *keys* but never generates *values*.

**Worked example:** Creator asks "Can I reshare the content on my own channels?"
→ router matches the usage-rights rule → selects the `usageRights` section →
`_resolve_value` finds the campaign field `usageRights = "6-month paid social on the
brand's handles"` (authoritative) → renders `**Usage Rights:** 6-month paid social…`
into the prompt → the draft says "You'll have it for 6 months of paid social" and
defers honestly on organic resharing if that's not specified.

---

## 14. Step 11 — After ACCEPT: the fork

When an instance reaches `ACCEPTED`, `instance.postAcceptanceMode` (stamped at
enrollment) decides the branch:

- **`operator_handoff`** → **Path A** (§15): snapshot the deal, tell the creator a
  human is taking over, park for the operator.
- **`local_payment`** → **Path B** (§16): fully automated fulfillment — optionally
  behind a brand-approval gate — payout form → content brief → content links.

The runtime's `loadContext` resolves the `CONTENT_BRIEF` node as the owner of the
post-accept states, so dispatch stays state-driven regardless of `currentNodeId`.

---

## 15. Path A — Operator handoff

**Executor:** `server/src/engine/executors/operatorHandoff.ts`, `operatorHandoffEmail.ts`
**DB:** `server/src/db/dealHandoffs.ts`
**Notify:** `server/src/notifications/escalation.ts`
**Queue UI/API:** `server/src/routes/manualQueue.ts`

When `postAcceptanceMode = operator_handoff` and the creator accepts, the run **pauses
for a human** instead of collecting payment. `executeOperatorHandoff`:

1. **Resolves the agreed terms** — the agreed fee from replaying `NEGOTIATION_TURN`
   events (`resolveAgreedFee`), plus commission, deliverables, timeline, payment
   terms, band, reward — each through the knowledge-precedence ladder, tracking the
   *source* of each field for the debug payload. (Commission-only deals legitimately
   close with **no fee** — that's not an escalation here, because a human is already
   the reviewer.)
2. **Snapshots to `DealHandoff`** (insert-once on unique `instanceId`): `creatorName`,
   `creatorEmail`, `campaignName`, `fixedFee`, `commissionRate`, `negotiationFloor`/
   `Ceiling`, `deliverables`, `timeline`, `paymentTerms`, `rewardDescription`,
   `acceptanceMessage` (the accepting turn's text), `threadId`, `acceptedAt`, and
   `status = AWAITING_FINALIZATION`. It's **not** a copy of the conversation (that
   stays in `Message`) and holds **no** payout info (collecting that is exactly what
   handoff skips).
3. **Emails the creator a short, quiet note** — "That sounds great. I'm looping in our
   campaign manager to finalize your onboarding details…" (CC's the operator only if
   `notifyEmail` is a real address). Sent idempotently (`deal-handoff:{instanceId}`).
4. **Parks in `NEEDS_DEAL_FINALIZATION`** (`nextNodeId: null` — no node owns this
   waiting state), logs `DEAL_HANDOFF_REQUESTED`.
5. **After the state commits**, `notifyOperatorOfDealFinalization` emails the
   brand/operator the agreement summary + a link to the inspector (idempotent on
   `instanceId + reason`).

**The operator** sees the deal in the **Manual Queue**
(`GET /manual-queue/workflows/:workflowId` joins the `DealHandoff` so agreed
compensation shows inline), finalizes onboarding in main Pluvus, then
`POST /manual-queue/instances/:id/handoff/complete` → `completeDealHandoff` flips the
row to `COMPLETED` (guarded to only match `AWAITING_FINALIZATION`) and the instance
transitions to `HANDOFF_COMPLETE` (terminal).

**Creator replies while parked** are handled by `recordHandoffReply`
(`runtime.ts`): it persists the message and **forwards it to the operator**
(`notifyOperatorOfHandoffReply`) but deliberately **does not step, transition, or
auto-reply** — the human owns this conversation now. (Kept a separate handler because
the normal `injectReply` would try an invalid `REPLY_RECEIVED` transition from
`NEEDS_DEAL_FINALIZATION` and throw.)

**End-to-end example:** Maya asks $480 (band $300–$500), we counter $400, she accepts.
`postAcceptanceMode = operator_handoff` → `DealHandoff` snapshot (`fixedFee: 400`,
deliverables "3 IG Reels", timeline "30 days") → creator gets the "looping in our
manager" note → `NEEDS_DEAL_FINALIZATION` → manager@tempo.co gets the summary email →
manager onboards Maya in main Pluvus → marks complete → `HANDOFF_COMPLETE`.

---

## 16. Path B — Local payment (+ the brand-approval gate)

**Executors:** `contentBrief.ts`, `contentLinksReply.ts`, `brandApproval.ts` (+ email/token/reject helpers)
**Routes:** `paymentPage.ts`, `payment.ts`, `brandApproval.ts`, `brandApprovalPage.ts`
**DB:** `paymentInfo.ts`, `brandApprovals.ts`
**Sweep:** `brandApprovalSweep.ts`

When `postAcceptanceMode = local_payment`, the merged `CONTENT_BRIEF` node runs the
whole fulfillment chain automatically. (In the current merged flow the legacy
`REWARD_SETUP`/`PAYMENT_INFO` nodes are collapsed into `CONTENT_BRIEF`, which sends the
finalized offer + payout link + brief PDF in **one** email.)

### The optional brand-approval gate

Gated by `BRAND_APPROVAL_GATE_ENABLED`. When **on**, after ACCEPT the deal doesn't
send the brief immediately — it asks the brand to sign off first:

1. `executeBrandApproval` resolves the terms, snapshots a `BrandApproval` row
   (insert-once), mints a **magic-link token** (32 random bytes; only the **sha256
   hash** is stored, the raw token exists only in the email), and emails the brand
   (at `notifyEmail`) **Approve** / **Reject** links with the creator name + agreed
   terms. TTL `BRAND_APPROVAL_TTL_DAYS` (default 14). The instance parks in
   `AWAITING_BRAND_APPROVAL`.
2. The links are **GET interstitials** (mail scanners prefetch GET, so GET never
   mutates; the actual decision is a POST with the token in a hidden field, plus
   `Referrer-Policy: no-referrer`/`no-store`). A **two-phase claim**
   (`AWAITING_APPROVAL → PROCESSING → APPROVED/REJECTED`) makes a double-click or
   scanner prefetch a safe no-op.
3. **Approve** → steps the `CONTENT_BRIEF` send phase → `PAYMENT_PENDING` (exactly what
   a non-gated accept would do, just deferred). **Reject** → a direct OCC transition to
   `MANUAL_REVIEW` (never runs the brief send) + a courteous, data-free close email to
   the creator (reserved **after** the reject commits, so a rolled-back reject can't
   email the creator).

> **CRITICAL-1:** the reject-vs-approve reply must come from the **brand's**
> `notifyEmail`, not the creator — the party the system distrusts must not be able to
> resolve its own escalation. Inbound `Message` rows persist `senderEmail` precisely to
> enforce this.

A poller sweep (`brandApprovalSweep.ts`) reverts a stranded `PROCESSING` claim back to
`AWAITING_APPROVAL` after `BRAND_APPROVAL_STALE_CLAIM_GRACE_MS` (5 min) — but only if
the instance is still awaiting, so a decided deal is never re-opened.

### The payout form

The content-brief email carries a **capability URL**:
`http://localhost:3001/payment/{token}`. The token is minted per instance (only the
sha256 hash stored; raw only in the email; 30-day expiry scoped to `PAYMENT_PENDING`).
The hosted form (`paymentPage.ts`) collects:

- `method` — `PAYPAL` / `WISE` / `BANK_TRANSFER`
- `accountIdentifier` — PayPal/Wise email or bank id (free text; not validated against
  a provider in the prototype)
- `country`, `notes`
- a **shipping address** when the campaign's `shipsPhysicalProduct` is true (read from
  the immutable published version so the form matches what was published)

On submit, `markPaymentReceived` persists the fields (`PAYMENT_RECEIVED`) and
`handlePaymentSubmission` steps the node → mints the money ledger (a `Partnership` +
an auto fixed-fee obligation if the fee > 0; a mint failure escalates to
`MANUAL_REVIEW` since payout data is already stored) → parks in
`CONTENT_LINKS_PENDING`.

### Content-link collection

Parked in `CONTENT_LINKS_PENDING`, the creator is asked to reply in-thread with their
content links (`contentLinksReply.ts`):

- **Opt-out** → `OPTED_OUT` (terminal, no auto-reply).
- **URLs present** — `extractContentUrls` (deterministic regex, trims trailing
  punctuation, de-dupes; only absolute `http(s)://` URLs) → appends a
  `CONTENT_LINKS_SUBMITTED` event with the URLs → escalates to `MANUAL_REVIEW` for
  operator review of the content.
- **No URLs** → sends a gentle nudge ("reply with the link once it's live") and stays
  in `CONTENT_LINKS_PENDING`.

### Payouts & attribution (hybrid/affiliate)

For campaigns with commission, `POST /attribution/conversion` (a webhook, auth'd by a
constant-time secret) records a `Conversion` against the partnership's referral code,
computes `commissionCents = valueCents * rate / 100` (idempotent on `externalId`), and
logs a `CONVERSION_RECORDED` event. Commission payouts batch unpaid conversions into a
`Payout` (`PENDING → SENT → CONFIRMED/DISPUTED → SETTLED`); the creator confirms/
disputes via a magic link; an auto-settle sweep settles `SENT` payouts after
`PAYOUT_AUTO_SETTLE_DAYS` (7). Payout destination is **copied** from `PaymentInfo` at
partnership-mint time, so later edits don't retro-alter existing payouts.

---

## 17. Conversation memory, obligations & summaries

Three ledgers keep the AI grounded across a long, multi-turn conversation.

### Conversation obligations (PLU-111)

**Model:** `ConversationObligation`; **executor:** `commitmentDetection.ts`; **DB:**
`conversationObligations.ts`.

Tracks two kinds of open threads with their own lifecycle:
- `CREATOR_QUESTION` — something the creator asked that we owe an answer to.
- `PLUVUS_COMMITMENT` — a promise **we** made ("I'll confirm the usage rights").

Lifecycle: non-terminal `OPEN`/`DEFERRED`/`ESCALATED` (stay in the AI context every
turn) → terminal `ANSWERED`/`COMPLETED`/`CANCELED`/`NO_LONGER_RELEVANT`. When an email
is **sent**, a deferral classifier scans it: "we'll confirm the exact usage rights in
onboarding" + a shared keyword with the open question → mark `DEFERRED` + mint a
`PLUVUS_COMMITMENT`; a real answer → `ANSWERED`. Crucially, the ANSWERED transition is
gated on the resolving message's `sentAt` (flush), so a resolution can never precede
delivery.

### Creator memory (PLU-113)

**Executor:** `creatorMemory.ts`; **DB:** `campaignCreatorMemory.ts`; **UI:**
`web/src/components/MemoryPanel.tsx`; flag `CREATOR_MEMORY_ENABLED`.

Durable per-campaign facts about a creator (e.g. `REQUESTED_RATE`, `MINIMUM_RATE`,
`AVAILABILITY`, `MANAGER_INVOLVED`, `LOGISTICS_CONSTRAINT`…). `creatorFacts` come back
from `/negotiate`, but the server **verifies every fact before persisting**: the
evidence text must actually appear in the creator's reply; numeric facts must ground
to a single unambiguous number; confidence must clear `MEMORY_MIN_CONFIDENCE` (0.5).
Storage is an **immutable head + revision history** (ACTIVE/CONFLICTED/SUPERSEDED/
REMOVED) with source provenance (`ai`/`operator`/`system`). Memory writes are applied
**fail-soft after** the turn commits — a memory error records a recoverable
`FailedMemoryWrite`, never rolls back the reply.

### Rolling summaries (PLU-112)

**Agent:** `agent/app/routes/summarize.py` (`summary-v1.0`); **server:**
`conversationWindow.ts`, `summaryRefresh.ts`; flag `CONVERSATION_SUMMARY_ENABLED`.

To bound context on long threads, the newest ~8 turns stay verbatim while older turns
are folded into a **narrative-only** summary (no dollar/percent figures — those live
in events/obligations/memory; the summary guard strips any money figure the model
invents). A compound `(sentAt, messageId)` cursor tracks what's been summarized, with
compare-and-swap refresh so a batched same-timestamp send can't drop or double-count a
turn. Fail-soft: on any error the prior summary is kept.

---

## 18. The reliability backbone

The state machine only works because the plumbing makes it durable under crashes and
races. Entry point: `server/src/index.ts` reads `PROCESS_ROLE`
(`api`/`worker`/`scheduler`/`all`) so the API, workers, and scheduler can scale
independently. `server/src/app.ts` mounts the routes (operator routes behind an
operator-key middleware; creator/webhook routes open).

### 18.1 Queues (BullMQ/Redis)

Three queues (`server/src/workers/queues.ts`):
- `node-execution` — advance one instance by one step.
- `inbound-email` — process a creator reply.
- `delayed-send` — flush a reserved send after its randomized delay.

Jobs retry 3× with exponential backoff; exhausted jobs are written to a durable
**dead-letter** table (`deadLetter.ts`). Job ids are **deterministic**
(`node-exec|instance|state|triggerRef`), so a duplicate enqueue from a retrying
producer is deduped by BullMQ.

### 18.2 Workers

- **node-execution worker** — idempotency-checks the expected state, takes a per-
  instance Redis lock (fencing token, 6-min TTL), calls `runtime.stepInstance`,
  releases the lock. A busy lock is skipped (the reconciliation sweep will find it).
- **inbound-email worker** — verifies the account matches, short-circuits only on
  `processedAt` (not mere row existence, so a crash mid-handler re-processes), then
  steps.
- **delayed-send worker** — reloads the send context, claims the outreach pacing slot
  if applicable, flushes under a per-send lock, and completes the
  `OUTREACH_QUEUED → OUTREACH_SENT` transition. **Must run even when send-delay is
  disabled** (delay-0 still routes through the queue).

### 18.3 Scheduler, poller & sweeps

A single leader-elected scheduler (Redis lease, `lock.ts`) runs a **30-second poller**
(`poller.ts`). Each tick it:
1. renews leadership,
2. runs **reconciliation** — re-enqueues instances stranded in a transient state whose
   `updatedAt` is older than ~10 min (the backstop for "state moved but no job got
   queued"),
3. re-drives dead-lettered inbound jobs,
4. auto-settles old `SENT` payouts,
5. **sweeps stranded sends** (reserved-but-unsent rows whose delayed job was lost),
6. reverts stranded brand-approval claims,
7. logs worker-fleet metrics,
8. scans **due instances** (`dueAt <= now`, batch of 200) and enqueues their steps.

### 18.4 Optimistic concurrency control (OCC)

`updateInstanceStateConditional` (`server/src/db/instances.ts`) writes the new state
only if `(currentState AND version)` still match the loaded snapshot, bumping
`version` on success. Two workers racing on one instance: the first wins, the second's
conditional update matches 0 rows → returns null → the step is a clean no-op
(`StaleInstanceError`). The version guard also covers X→X self-transitions (BUG-E1).
The state write and its audit events (including the `NEGOTIATION_TURN` money trail)
commit in **one transaction** (W-7), so a crash can't record a rate with no event (or
vice-versa).

### 18.5 Randomized send delay

AI replies flush 30 s – 5 min later (or the campaign's negotiation pacing) so they read
as human, not instantaneous. The send is **reserved** (row written, not sent) inside
the OCC turn, and the **flush** is enqueued as a delayed job *after* the transaction
commits — so a rolled-back turn leaves an orphaned reservation that never sends. A
poller safety-net sweep reclaims a reservation whose job was lost, bounded by
`redriveCount < SEND_DELAY_MAX_REDRIVES` and an age cap, with an orphan guard that
requires a committed owning event before flushing.

### 18.6 Outreach pacing & daily cap (PLU-122)

`claimInitialOutreachSlot` (`outboundPacing.ts`) atomically claims one campaign
initial-outreach slot inside a `FOR UPDATE` campaign-row lock (serializing concurrent
workers): it checks `dailyInitialOutreachLimit` against a per-UTC-day
`CampaignOutreachDay.startedCount` and enforces per-send pacing via
`nextEligibleAt`. If the cap is hit or it's too soon, the job **defers** (re-queued);
otherwise it claims the slot (idempotent via the message's `initialOutreachQuotaDay`
marker) and sends.

---

## 19. Observability & security

**Observability** (`server/src/observability/*`, `routes/observability.ts`): every
state transition and notable event is logged as structured JSON
(`[transition]`/`[trace]`) with `source`/`worker`/`queueJobId` for correlation. LLM
usage (model, tokens, latency, cost, prompt version) is attributed per instance via
`AsyncLocalStorage` and persisted as `LlmCall` rows (HARD-O1). The API exposes
per-workflow state counts, worker-fleet metrics, an operator **alerts** roll-up (queue
failures, manual-review backlog, failed notifications, LLM daily-spend, stuck
instances), and per-instance detail (timeline, messages, decisions, obligations,
memory, knowledge, context, usage, logs) — which is exactly what the web **Monitor**
and **Instance Inspector** render.

**Security:**
- **Operator key** — operator routes require `X-Operator-Key`; open-when-unset only in
  local dev; a boot guard refuses to start in production without it.
- **Rate limiting** — a generous global bucket + a tighter public bucket on
  `/webhooks`/`/payment`/`/attribution`/etc.
- **Nylas webhooks** — HMAC signature verification + an in-memory replay guard.
- **SSRF/open-redirect** — `targetUrl` is validated before storage.
- **Agent side** — API-key auth (constant-time), per-route rate limiting,
  prompt-injection detection, and untrusted-creator-text neutralization (strip
  control chars, neutralize `<creator_reply>` delimiter mimicry and `system:` role
  markers) before any creator text reaches the model.

---

## 20. Feature-flag & prompt-version reference

### Feature flags (most ship **dark** / off)

| Flag | Default | Gates |
|---|---|---|
| `BRAND_APPROVAL_GATE_ENABLED` | off | Brand Approve/Reject gate before the brief send (§16). |
| `CREATOR_MEMORY_ENABLED` | off | Persist verified per-campaign creator facts (§17). |
| `CONVERSATION_SUMMARY_ENABLED` | off | Rolling narrative summaries on long threads (§17). |
| `STRUCTURED_BRIEF_PARSING_ENABLED` | off | Structured section parsing of the brief vs flat text (§13). |
| `BRIEF_OCR_FALLBACK_ENABLED` | off | OCR scanned/image-only briefs (§13). |
| `KNOWLEDGE_RETRIEVAL_ENABLED` | off | Deterministic per-turn section retrieval (§13). |
| `KNOWLEDGE_CLASSIFIER_ENABLED` | off | LLM section classifier on the uncertain path only (§13). |
| `MATERIAL_CONFLICT_ESCALATION_ENABLED` | off | Escalate on brief-vs-campaign term conflicts (detection always runs) (§13). |
| `SEND_DELAY_ENABLED` | on (prod) | Randomized reply send delay (§18.5). |

Key infra env: `PROCESS_ROLE`, `REDIS_URL`, `WORKER_CONCURRENCY`,
`SCHEDULER_LEADER_TTL_MS`, `SEND_DELAY_{MIN,MAX}_MS`,
`BRAND_APPROVAL_STALE_CLAIM_GRACE_MS`, `PAYOUT_AUTO_SETTLE_DAYS`, `OPERATOR_API_KEY`,
`BRAND_NOTIFY_EMAIL`, `LLM_PROVIDER` (+ per-role overrides), `EMAIL_PROVIDER`.

### Prompt versions (stamped on every LLM call for eval regression detection)

| Purpose | Version | File |
|---|---|---|
| Classify reply intent | `classify-v1.1` | `agent/app/routes/classify.py` |
| Negotiate (LLM strategy) | `llm-negotiate-v1.7` | `agent/app/routes/negotiate.py` |
| Negotiate (rules fallback) | `rules-extract-v2.0` | `agent/app/routes/negotiate.py` |
| Draft copy | `draft-v2.2` | `agent/app/routes/negotiate.py` |
| Offer / onboarding / follow-up copy | `offer-v2.3` / `onboarding-v2.3` / `followup-v2.1` | `agent/app/routes/negotiate.py` |
| Outreach template authoring | `outreach-template-v1.1` | `agent/app/routes/outreach_template.py` |
| Conversation summary | `summary-v1.0` | `agent/app/routes/summarize.py` |
| Knowledge classifier | `knowledge-classifier-v1.0` | `agent/app/knowledge_classifier.py` |
| Brief parser | `brief-parser-v1.1` | `agent/app/brief.py` |

---

## Appendix — where to look for what

| I want to understand… | Start here |
|---|---|
| The state machine loop | `server/src/engine/runtime.ts`, `stateMachine.ts` |
| A specific node's behavior | `server/src/engine/executors/<node>.ts` |
| The data model | `server/prisma/schema.prisma`, `server/src/db/schema.ts` |
| Money-safety guards | `agent/app/routes/negotiate.py` (`_apply_decision_guards`) |
| The band | `server/src/engine/band.ts` |
| Knowledge precedence | `server/src/engine/knowledgePrecedence.ts`, `readme_docs/KNOWLEDGE_PRECEDENCE.md` |
| Brief parsing / OCR | `agent/app/brief.py`, `readme_docs/OCR_FALLBACK_FEASIBILITY.md` |
| Multi-mailbox design | `.claude/spec/plu-121-multi-mailbox-remediation/PLAN.md` |
| Outreach variables | `server/src/engine/outreachVariables.ts` |
| Queues/workers/sweeps | `server/src/workers/*`, `server/src/scheduler/*` |
| Deploy / ops | `DEPLOYMENT.md`, `readme_docs/ENV_VARS.md` |
