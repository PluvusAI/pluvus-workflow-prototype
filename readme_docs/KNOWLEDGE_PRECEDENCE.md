# Campaign Knowledge Precedence & Failure States (PLU-82)

**One documented, deterministic source order per knowledge category — plus a brief
result that says *why* it's empty, and a material conflict that stops the AI from
confidently answering a creator with a value two sources disagree on.**

This is the human-readable rendering of `server/src/engine/knowledgePrecedence.ts`
(`PRECEDENCE_BY_CATEGORY`) and the surrounding failure-state machinery. It is a
**consolidation/refactor** — the precedence already existed, scattered as inline
`firstString(config, negotiationConfig, campaign)` chains across three
post-acceptance executors; PLU-82 unifies it behind one resolver and closes three
gaps (undocumented precedence, no availability state, swallowed conflicts).

---

## 1. The resolver — `resolveKnowledgeField(category, sources)`

The **LLM never decides between conflicting sources — code does, deterministically,
by documented order.** The resolver walks a category's ordered slot list, returns
the **first present value** *and a label naming which source won*, and reuses
`firstString` / `firstNumber` from `agreedFee.ts` so its emptiness semantics
(whitespace-only = empty, `NaN` = absent) are byte-identical to the inline chains it
replaces.

The winning-source label is recorded on the post-acceptance executors' event
payloads (`resolvedSources: { deliverables: "workflow_config", … }`) and surfaced in
the observability inspector's **Knowledge** panel — the "selected source in internal
debug context" requirement.

### Source slots (the canonical ladder)

| Label | Slot | Meaning |
|---|---|---|
| `confirmed_agreement` | `confirmedAgreement` | A real confirmed creator agreement (e.g. `resolveAgreedFee` for the fee). |
| `operator_override` | `operatorOverride` | **PLU-113 seam — no producer on this branch; always `undefined`.** Position fixed + unit-proven so a future feature lights up with no resolver change. |
| `workflow_config` | `workflowConfig` | THIS node's published config (`node.config`) — "node config wins". |
| `negotiation_state` | `negotiationState` | The NEGOTIATION node's config. |
| `campaign_default` | `campaignDefault` | The `campaign.*` column. |

> The brief is **not** a slot. It is a **conflict challenger, never a resolution
> fallback** (see §3). A brief value can never silently win a resolution.

---

## 2. Precedence BY FIELD CATEGORY

**One universal hierarchy does not fit every field.** There are two families.

### Finalized-terms family

Node config wins over negotiation state wins over campaign — i.e. exactly
`firstString(config, negotiationConfig, campaign)`.

| Field (category) | Ordered precedence | "Universal ladder doesn't fit" note |
|---|---|---|
| **fixedFee** | CA (`resolveAgreedFee`) → *[OO]* → **else escalate** | **Special-cased OUT of the resolver.** Never NS/WC/CD/band — code must never fabricate a fee. Contract-forming callers escalate on absence. |
| **commissionRate** | OO → **WC → NS** | No CA (commission is a fixed brand term, not per-creator-negotiated). No CD, no brief. |
| **deliverables** | OO → **WC → NS → CD** | The canonical 3-tier. |
| **timeline** | OO → **WC → NS → CD** | Same. |
| **rewardDescription** | OO → **WC → NS → CD** | Same. |
| **paymentTerms** | OO → **WC → CD** | **NS deliberately SKIPPED** — the preserved inconsistency (see §2.1). |

### General-knowledge family

Campaign field is authoritative for the value; the brief only *disagrees loudly*.

| Field (category) | Ordered precedence | Note |
|---|---|---|
| **usageRights** | OO → WC → CD | Brief = conflict challenger, not a fallback tier. Always-escalate topic when the creator *asks* (`topic_gate.py`). |
| **exclusivity** | OO → WC → CD | Same as usageRights. |
| **attributionWindow** | OO → WC → CD | Brief = conflict challenger only. |

> **brandName / senderName / brandDescription** resolve through
> `resolveBrandName` / `mergeCampaignFallback` (a *different, untouched* layer). They
> are not arbitrated by this resolver.

### 2.1 The `paymentTerms` inconsistency is PRESERVED, not fixed

`operatorHandoff.ts` resolves `paymentTerms` as `config → campaign`, **skipping
`negotiationConfig`**, while deliverables/timeline include it. `paymentTerms`
snapshots into `DealHandoff` and renders to the brand, so silently changing its
source order would change a real deal's stated terms. The mechanical migration keeps
it byte-identical (WC → CD). Harmonizing it (adding NS) is a **separate, labeled,
golden-tested** change — out of scope for v1. The golden per-executor tests
(`finalizedTermsPrecedence.golden.test.ts`) lock this.

---

## 3. Brief availability — the four-state failure result

`deriveBriefAvailability(resolved, expectedSections)` projects the existing
`ResolvedBrief.status` (PLU-107) + which *expected* sections are present into the
issue's four-state result. **Missing ≠ failed ≠ absent.**

| `ResolvedBrief.status` | parse capability + content | `BriefKnowledgeResult.status` |
|---|---|---|
| `no_brief` (no ref on the graph) | — | **`NO_BRIEF`** |
| `parse_failed` (unreadable / agent down) | — | **`PARSE_FAILED`** (error set) |
| `empty` (parsed, no extractable text — scanned/image PDF) | — | **`PARSE_FAILED`** — present-but-unreadable ≠ absent |
| `ok` | no usable flat text or section content | **`PARSE_FAILED`** |
| `ok` | `flat` mode + readable text | **`AVAILABLE`** — sections were not attempted |
| `ok` | `structured` mode + every *expected* section present | **`AVAILABLE`** |
| `ok` | `structured` mode + ≥1 *expected* section absent | **`PARTIAL`** (lists the missing keys) |

- **`expectedSections` = the campaign's declared fields ∩ the four conflict keys**,
  NOT all possible keys — otherwise every brief is `PARTIAL` forever.
- The availability mapping itself is a **pure projection** and **gates no prompt in
  v1**. Parse capability is selected earlier by the resolver and is part of the
  cache identity (`empty` stays cached; `parse_failed` stays uncached — the BUG-E8
  fix). The result is surfaced in the inspector's Knowledge panel; the agent still
  owns honest-defer.

---

## 4. Material conflict → MANUAL_REVIEW (flag-gated)

`detectBriefConflicts` (PLU-107) already flags a "Net 60" brief against a "Net 30"
campaign. PLU-82 **routes** that to MANUAL_REVIEW — but only when it would let the AI
give an *unsupported automated answer*.

**The gate (`conflictAffectsCreatorCommitment`) requires ALL of:**
1. the conflicting field is a creator-commitment field (`usageRights` / `exclusivity`
   / `paymentTerms` / `attributionWindow`);
2. the creator **asked about that exact field this turn** — matched
   **field-specifically** via `CONFLICT_FIELD_PATTERNS` (each field has its own
   pattern, so a usage-rights ask does **not** match an exclusivity-only conflict)
   **OR** has a non-terminal open obligation whose coarse category unambiguously maps
   to that field (see the fallback note below);
3. the agent did **not** already escalate (`outcome !== "escalate"` — defer to the
   topic gate's reason, never race it).

> **Field-specific matching (review §5).** Earlier, `usageRights` and `exclusivity`
> shared the coarse `usage_rights` bucket, so an ask about one could escalate a
> conflict on the other. This-turn matching now uses each field's own pattern.
> **Open obligations** from prior rounds carry only the coarse category (they can't
> tell the two apart), so they are a **conservative fallback**: a coarse open
> obligation in a *shared* category (`usage_rights`) does **not** back-fill either
> sibling — only an unambiguous category (e.g. `payment`) does. A this-turn
> field-specific ask always matches.

**Why the gate matters:** a brief-vs-campaign conflict exists on *every* turn from
round 0, independent of the creator. Escalating on conflict-*existence* alone would
dump the deal to MANUAL_REVIEW on "yes I'm interested" — a catastrophic
false-positive rate. This is why the escalation sits **after** `agent.negotiate`.

On a match → MANUAL_REVIEW with reason `material_knowledge_conflict`; the brand FYI
fires automatically (`eventPayload.reason`), and the open obligations move to
`ESCALATED` (`escalateAfterWrite`). The escalation is a **terminal** MANUAL_REVIEW,
so the negotiation executor never runs again — no escalation loop.

> **`attributionWindow`** now has its **own** field-specific pattern (review §5), so a
> conflict on it escalates when the creator actually asks about the attribution /
> conversion window. It still has no *coarse* obligation category
> (`detectObligationCategory` emits none), so an old open obligation can't back-fill
> it — only a this-turn ask matches. Previously it was detected but structurally
> unable to escalate at all.

### 4.1 Recovery — active vs cleared conflicts (review §6)

Conflicts are surfaced from the event log across all turns, but each carries a
**status**:

- **`active`** — still present in the **most recent chronological knowledge
  snapshot**.
- **`cleared`** — present in an earlier snapshot but **absent from the latest
  snapshot** (the source was corrected).

So the operator panel distinguishes a *historical* conflict, a *currently active*
one, and a *since-corrected* one. `briefAvailability` is already latest-wins; the
conflict list previously unioned every conflict ever seen, which made a fixed
conflict read as though it were still live. Sequence, not negotiation-round number,
determines liveness: a later clean `present_offer` snapshot clears an earlier
conflict even when both events share a round, and the same applies to legacy
null-round events. Round remains display metadata only. A plain event with **no**
knowledge block is **not** treated as a re-resolution, so it never falsely clears a
standing conflict. Recovery is **per-field** — one field can clear while another
stays active. Every committed negotiation turn that actually resolved the brief
persists a compact snapshot, including `AVAILABLE` with `conflicts: []`, so healthy
recovery is explicit.

---

## 5. Supported conflict scope (review §7)

The material-conflict detector + escalation currently covers a **subset** of the
fields the Linear issue lists. This is intentional for v1; the rest is deferred.

| Field | Detected? | Can escalate? | Notes |
|---|---|---|---|
| `paymentTerms` | ✅ | ✅ | coarse category `payment` (unambiguous → open-obligation fallback works). |
| `usageRights` | ✅ | ✅ | field-specific this-turn match; shared coarse bucket → no cross-trigger. |
| `exclusivity` | ✅ | ✅ | field-specific this-turn match. |
| `attributionWindow` | ✅ | ✅ | this-turn ask only (no coarse category for open-obligation fallback). |
| `deliverables` | ❌ | ❌ | **deferred** — not in `_CONFLICT_KEYS` / `detectBriefConflicts`. |
| `deadline` / `timeline` | ❌ | ❌ | **deferred**. |
| `commission` / `fixedFee` | ❌ | ❌ | **deferred** (fee is special-cased out of the resolver entirely — see §2). |

Deferred fields are still resolved by the precedence table (§2); they are simply not
part of the brief-vs-Campaign **conflict** detection/escalation yet. Widening the
detector is a separate, golden-tested change.

---

## 6. Flags

| Flag | Side | Default | Gates |
|---|---|---|---|
| `MATERIAL_CONFLICT_ESCALATION_ENABLED` | server | **OFF** | ONLY the escalation *decision* (§4). Detection + observability ship unconditionally. |
| `STRUCTURED_BRIEF_PARSING_ENABLED` | server request / agent legacy fallback | OFF | Whether the brief parses to structured `sections`. The server sends explicit `parseMode`; the agent flag remains fallback for old/direct callers. No sections → no conflicts → escalation inert regardless of the flag above. |
| `KNOWLEDGE_RETRIEVAL_ENABLED` / `BRIEF_INTO_NEGOTIATE` | server | OFF | Brief *text into the prompt* — **orthogonal** to the escalation flag. |

### Flag matrix (what fires)

| `STRUCTURED_BRIEF_PARSING_ENABLED` | `MATERIAL_CONFLICT_ESCALATION_ENABLED` | Behavior |
|---|---|---|
| OFF | any | flat parse → no conflicts → **no escalation**; readable flat text is `AVAILABLE` (`NO_BRIEF` / `PARSE_FAILED` still describe absent/unreadable files; never `PARTIAL`) |
| ON | OFF | conflicts detected + **surfaced in observability**; **no escalation** (`console.warn` + Knowledge panel) |
| ON | ON | conflicts detected + surfaced + **escalate to MANUAL_REVIEW** when the §4 gate fires |

The precedence-resolver migration and the availability projection are **not flagged**.
They do not change prompt content or deal decisions.

`/parse-brief` reports `parseMode: flat | structured`, and the server includes that
mode in the cache key. A flag toggle therefore cannot reuse a result produced by
the other capability. Responses from an older agent that omit `parseMode` remain
compatible: a section map proves structured mode; otherwise a successful text-only
response is treated as flat and therefore does not become a false `PARTIAL`.

Rolling deploys are safe in both directions. A new server's additive `parseMode`
request is ignored by an old agent, and its legacy response is inferred as above;
an old server omits the field, so a new agent falls back to its environment flag.
If an old agent does not honor a requested mode, its result is cached only under
the mode it actually produced, so the requested-mode read keeps missing until the
matching agent version is live. Keep the shared flag equal in both environments
during the rollout to avoid needless re-parses.

**Flags OFF ⇒ byte-identical to today on every prompt and every real deal.**

---

## 7. What this does NOT touch

- No dollar figure moves — `fixedFee` still comes only from `resolveAgreedFee` or
  escalates; conflict detection *reports* a money disagreement, never changes a fee.
- No real deal's resolved terms change (byte-identical migration, golden-tested;
  `paymentTerms` order preserved).
- `mergeCampaignFallback` + its tests are untouched (a different layer).
- The brief never becomes a resolution source — conflict challenger only.
- No migration, no new table, no new `EventType` — the debug record rides the
  existing event payload.

---

## 8. Where it lives

| Concern | File |
|---|---|
| The resolver + `PRECEDENCE_BY_CATEGORY` | `server/src/engine/knowledgePrecedence.ts` |
| Executor migration (3 call sites) | `operatorHandoff.ts` / `rewardSetup.ts` / `contentBrief.ts` |
| Brief availability projection | `server/src/engine/executors/briefKnowledge.ts` (`deriveBriefAvailability`) |
| Parser-version cache (review §3) | `briefKnowledge.ts` (`expectedParserVersion`, env `BRIEF_PARSER_VERSION`) |
| Conflict gate + escalate helper | `server/src/engine/executors/negotiation.ts` (`conflictAffectsCreatorCommitment`, `CONFLICT_FIELD_PATTERNS`, `escalateMaterialConflict`) |
| Reason labels (two maps — keep in sync) | `routes/manualQueue.ts` + `notifications/escalation.ts` |
| Observability DTO / mapper / panel | `observability/dto.ts` (`KnowledgeDTO`, conflict `status`), `repository.ts` (`mapKnowledge`), `web/src/components/KnowledgePanel.tsx` |
| Tests | `knowledgePrecedence.test.ts`, `finalizedTermsPrecedence.golden.test.ts`, `briefKnowledge.availability.test.ts`, `briefKnowledge.cache.test.ts`, `knowledgeMapper.test.ts`, `materialConflictEscalation.test.ts`, `reasonLabelParity.test.ts` |
