# File Storage → Cloudflare R2 — Implementation Plan

No Linear ticket cited for this — filed as a standalone infra plan, raised
directly in conversation rather than from a pasted ticket. Plan only, no
code written yet.

---

## 0. What exists today — grounded in an actual code read

**`server/src/storage/localFileStorage.ts`** is the one seam every caller
goes through: `saveUploadedFile(buffer, originalName) → { reference,
originalName }`, `resolveStoredFile(reference) → absolute path`,
`readStoredFile(reference) → Buffer`, `deleteStoredFile(reference) → void`.
`reference` is an opaque string (today: a random UUID + the source
extension, used as a filename under `<server>/uploads`, `basename()`-guarded
against path traversal). Its own header comment already anticipated this
exact migration: *"Intentionally tiny and dependency-free so it can be
replaced by an S3 / GCS backend later WITHOUT touching the workflow engine,
the executor, or the node config shape: swap the three functions... and the
reference simply becomes an object key."*

**8 real call sites** (grepped, excluding test/harness files):
- `routes/uploads.ts` — generic operator file upload.
- `routes/creatorImports.ts` — CSV import file (`saveUploadedFile` on
  upload, `readStoredFile` to re-parse, `deleteStoredFile` on discard).
- `engine/executors/contentBrief.ts` — reads the brand-uploaded Campaign
  Brief PDF (`briefFileRef`) to attach to the Content Brief email.
- `engine/executors/briefKnowledge.ts` — reads the same PDF to send to
  `/parse-brief` for RAG-able extraction.
- `routes/campaignBriefs.ts` / `routes/campaignBriefToken.ts` /
  `workers/campaignBriefRenderWorker.ts` — this session's new rendering
  pipeline (`saveUploadedFile` on render, `readStoredFile` on retrieval).

None of these callers touch a filesystem path directly — they only ever
pass `reference` back into this same module. That's the whole value of the
existing design: the migration below only has to change what's *inside*
`localFileStorage.ts`, not any of the 8 call sites.

**The correctness gap, confirmed by reading `docker-compose.yml`**: the
`api`/`worker`/`scheduler` services (the `app` profile — the split topology
`server/Dockerfile`'s own header comment describes: "ONE image, three
roles... scale worker horizontally") share **no volume** for `uploads/`.
Each container gets its own ephemeral disk. Concretely:
`campaignBriefRenderWorker.ts` runs under `PROCESS_ROLE=worker` and writes
the rendered PDF to *that container's* local disk; `GET
/campaigns/:id/brief/pdf` runs under `PROCESS_ROLE=api`, a **different**
container, and calls `readStoredFile()` on the same reference — which
404s, because the file never existed on the api container's disk. This is
latent today only because local dev (`npm run dev`, `PROCESS_ROLE` unset =
`"all"`) runs everything in one process. The moment `docker compose
--profile app up` is used for real — which is the topology this repo
already ships a Dockerfile and compose file for — cross-container file
reads break. Horizontally scaling `worker` (`--scale worker=3`) has the
same problem worker-to-worker (a creator-CSV import processed by one
replica, re-read by another).

**Container disk is also not durable** — a redeploy/restart of any service
loses everything written to it, uploads included.

---

## 1. Is R2 the right target? Cost, verified against Cloudflare's current
pricing page (not assumed from memory)

| | Cloudflare R2 (Standard) |
|---|---|
| Storage | $0.015 / GB-month |
| Class A ops (write/list) | $4.50 / million |
| Class B ops (read) | $0.36 / million |
| Egress | **$0**, unconditionally |
| Free tier | 10 GB-month, 1M Class A/mo, 10M Class B/mo |

The assets in play (campaign-brief PDFs, brand-uploaded briefs, creator-CSV
imports) are small (this session's own test render was 46.9KB) and
**read-heavy relative to writes** — one render, then repeated reads from
operator polling, the preview route, and eventually creator retrieval.
That's R2's exact sweet spot: S3's ~$0.09/GB egress is the cost that
compounds with read traffic; R2 has none. At this project's current scale
the free tier likely covers it outright for a long while. The case for R2
over S3 specifically is the zero egress; the case for R2 (or S3, or GCS —
any object store) over local disk is §0's correctness/durability gap, which
is the actual forcing function here, not price.

**S3-compatible**: R2 exposes the S3 API, so this uses `@aws-sdk/client-s3`
(the standard, well-maintained AWS SDK — no Cloudflare-specific SDK needed)
pointed at R2's endpoint (`https://<account-id>.r2.cloudflarestorage.com`)
with an R2 API token (access key ID / secret access key, generated in the
Cloudflare dashboard). New env vars needed: `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.

---

## 2. Proposed design — `STORAGE_PROVIDER`, matching this codebase's own
established provider-factory convention

This repo already solves "swap an external dependency by env var" three
times over — `EMAIL_PROVIDER=mock|nylas` and `AGENT_PROVIDER`/
`NEGOTIATION_PROVIDER=mock|langgraph` (`engine/providerFactory.ts`), and
`drizzle.ts`'s own Neon-vs-local-Postgres auto-detect. Same shape here
rather than inventing a new pattern:

```ts
// storage/storageProvider.ts (new)
export interface FileStorageProvider {
  saveUploadedFile(buffer: Buffer, originalName: string): Promise<StoredFile>;
  resolveStoredFile(reference: string): string | null; // null for R2 — no local path exists
  readStoredFile(reference: string): Promise<Buffer>;
  deleteStoredFile(reference: string): Promise<void>;
}

export function storageProvider(): FileStorageProvider {
  const raw = process.env["STORAGE_PROVIDER"];
  if (raw === undefined || raw.trim() === "") {
    if (isTestEnv()) return localFileStorageProvider;
    // Same posture as EMAIL_PROVIDER (providerFactory.ts): a split-container
    // deploy silently defaulting to local disk is the exact bug in §0 —
    // fail loud rather than let it reoccur silently.
    throw new Error(
      "STORAGE_PROVIDER is not set. Set STORAGE_PROVIDER=r2 (with R2_* env) " +
        "for real deploys, or STORAGE_PROVIDER=local to explicitly opt into " +
        "local-disk storage (single-process/dev only — breaks across the " +
        "api/worker split topology). Refusing to default silently.",
    );
  }
  const choice = raw.toLowerCase();
  if (choice === "r2") return r2StorageProvider;
  if (choice === "local") return localFileStorageProvider;
  throw new Error(`Unknown STORAGE_PROVIDER="${raw}". Expected "r2" or "local".`);
}
```

- **`localFileStorageProvider`** — today's `localFileStorage.ts` code,
  unchanged, wrapped to satisfy the interface. Stays the default for
  `npm run dev` and the test suite (zero network calls, zero R2 credentials
  needed to run `.db.test.ts` locally) — `resolveStoredFile()` keeps working
  for it since a real path exists.
- **`r2StorageProvider`** (new file, `storage/r2FileStorage.ts`) —
  `PutObjectCommand`/`GetObjectCommand`/`DeleteObjectCommand` against the R2
  bucket, keyed on the exact same `reference` string shape (a random UUID +
  extension) so **no caller-visible format change** — `reference` was always
  documented as opaque. `resolveStoredFile()` returns `null` for this
  provider (no local path exists); the one caller that uses it today,
  `readStoredFile()`'s own internals, moves the "resolve then read" logic
  inside each provider instead of leaking a filesystem assumption to
  callers.
- **8 call sites get ONE change each**: swap the direct
  `import { saveUploadedFile, ... } from "../storage/localFileStorage.js"`
  for `storageProvider().saveUploadedFile(...)` (or a thin re-exported
  `saveUploadedFile()` free function that delegates to
  `storageProvider()`, to avoid touching all 8 call sites' import lines —
  worth deciding at implementation time, leaning toward the free-function
  re-export since it's a strictly smaller diff for the same outcome).

## 3. Retrieval — proxy vs. presigned redirect

Two ways to serve bytes once this is live:

- **Proxy (recommended to start)**: routes keep doing exactly what they do
  today — `readStoredFile()` returns a `Buffer`, the route
  `res.send()`s it with `Content-Type`/`Content-Disposition` set server-side.
  Zero response-shape change for any caller (the two PDF routes I built this
  session, `contentBrief.ts`'s email attachment, `/parse-brief`'s upload).
  Auth check (operator key, or the creator token's hash lookup) happens
  fully server-side before any byte leaves the process — important for the
  creator-token route's "never leak whether a token almost matched"
  property, since a presigned-redirect approach would need the redirect
  itself gated identically anyway. R2 doesn't charge egress to *us* for
  this either, so the only cost of proxying is our own server's bandwidth/
  compute for the pass-through — negligible at this project's traffic.
- **Presigned redirect (later optimization, not needed now)**: after the
  same server-side auth check, mint a short-lived (60s) presigned GET URL
  (`@aws-sdk/s3-request-presigner`) and `302` the client to it, so Cloudflare's
  edge serves the bytes directly and our server's bandwidth drops to zero
  for that request. Worth revisiting if/when PDF traffic volume makes the
  proxy hop a real bottleneck — not a concern at current scale, and it's a
  route-internal change (swap `res.send(bytes)` for `res.redirect(url)`)
  that can happen later without touching the storage-provider interface
  above.

**Recommendation: start with proxy.** Simpler, no client/consumer changes
anywhere, and the cost/latency difference is immaterial until traffic is
much higher than this project currently has.

## 4. Migration of already-written local files

Current local `uploads/` contents: brand-uploaded Campaign Brief PDFs from
earlier sessions, plus this session's own test renders from
`campaignBriefRender.db.test.ts` runs (each test run writes real PDFs to
disk — never cleaned up automatically, matching this session's own
implementation-log note about `_scratch_pdf_smoke.mjs`'s deliberate manual
cleanup). Given there's no real production traffic yet, a clean **one-shot
migration script** is simpler than a dual-write transition window:

- `server/scripts/migrateUploadsToR2.ts` (new, matching the existing
  `scripts/backfill-gmail-labels.ts` / `scripts/cleanHarnessData.ts`
  convention — a `--apply` flag gate, dry-run by default, per this
  session's established "dry-run before real writes" posture): walk every
  file under `uploadsDir()`, `PutObjectCommand` each one to R2 under its
  **same** filename as the object key (preserves every existing DB
  `renderedAssetRef`/`briefFileRef`/`fileReference` value unchanged — zero
  DB migration needed for this, since `reference` was always opaque and
  those columns don't encode "local" anywhere), verify byte-length after
  upload, log a summary (migrated / already-present / failed).
- Cutover: flip `STORAGE_PROVIDER=r2` once the script's dry run confirms
  every referenced file exists in R2. Local files can stay on disk
  harmlessly afterward (nothing reads them once the env flips) or be
  deleted in a follow-up once confidence is high — not urgent either way.

## 5. Testing

Same DI/mocking conventions already established this session:
- `r2FileStorage.ts` unit-testable by mocking the `S3Client` the same way
  `LangGraphNegotiationProvider.test.ts` mocks `globalThis.fetch` — the AWS
  SDK v3 clients accept a mockable `send()` method, so a fake client with a
  scripted `send()` covers save/read/delete without a real R2 bucket.
  `.db.test.ts` files stay on `STORAGE_PROVIDER=local` (or an explicit
  in-memory fake) — no test should need real R2 credentials to run.
- A short integration check against a real (free-tier) R2 bucket before
  the first real deploy — not part of the automated suite, a one-time
  manual verification the same way this session's Puppeteer pipeline was
  manually smoke-tested before being trusted in the automated tests.

---

## Open questions

1. **R2 account/bucket already provisioned?** I have no visibility into
   whether a Cloudflare account/R2 bucket exists for this project yet —
   need the account id and a bucket name (or should I propose one) before
   any credential-dependent code can be tested for real.
2. **Free-function re-export vs. call-site rewrite** (§2) — keep
   `saveUploadedFile()` etc. as free functions that delegate to
   `storageProvider()` internally (smaller diff, 8 call sites unchanged), or
   have each call site call `storageProvider().saveUploadedFile()`
   explicitly (more visible, slightly larger diff)? Leaning toward the
   free-function re-export.
3. **Proxy vs. presigned redirect** (§3) — confirming proxy-to-start is the
   right call, not presigned URLs from day one.
4. **`STORAGE_PROVIDER` default posture** — proposed to fail loud if unset
   outside `NODE_ENV=test` (matching `EMAIL_PROVIDER`'s posture, since a
   silent local-disk default is the exact correctness bug in §0). Confirm,
   or prefer a softer default (e.g. warn + fall back to local) for now
   while R2 isn't provisioned yet?
5. **Existing local files** — leave them on disk after cutover, or delete
   once the migration script confirms everything's in R2?

Nothing implemented yet — this is plan-only, per this session's established
pattern for new-scope work.
