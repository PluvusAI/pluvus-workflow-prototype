# PLU-138 [1d] — Final source-of-truth map

Satisfies AC "the legacy source map is complete and attached" and the DoD "the final
source-of-truth map contains no undocumented active consumer."

## The rule
| Data category | Authoritative source |
| -- | -- |
| Launched public compensation structure + material terms (deliverables, timeline, usage rights, exclusivity, restrictions, public payment terms, attribution, public commission, reward) | **CampaignTermsSnapshot.detailsSnapshot** |
| Launched private negotiation authority (fee band, commission triad, tolerance, opening position, gift authority, guidance) | **NegotiationPolicySnapshot** |
| Final agreed fee / creator-specific terms | **creator-specific final-deal history** (resolveAgreedFee over persisted NEGOTIATION_TURN events; Partnership row) |
| Workflow order, node behavior, pacing (maxRounds), channel config | **WorkflowVersion.nodeGraph** |
| Brand presentation (brandName, senderName, brandDescription) | **BrandIdentity / node config** |
| shipsPhysicalProduct (campaign-derived boolean) | nodeGraph **compat** — snapshot cutover deferred to PLU-144 |

Snapshots are pinned once on `ExecutionInstance.campaignTermsSnapshotId` /
`.negotiationPolicySnapshotId` at enrollment (PLU-137), never rewritten. Units: policy
snapshot band is **integer cents**; legacy config band is **dollars** — converted ÷100
at one seam (`effectiveTerms.ts`).

## Mechanism
`server/src/engine/effectiveTerms.ts` `resolveEffectiveNegotiationConfig({policyAuthority?, termsSnapshot?, config})`
overlays the pinned snapshots onto the merged node config — **snapshot always wins**;
config is read per-field only when the corresponding snapshot is absent (a legacy
no-snapshot journey). Every material-term consumer reads the effective (overlaid)
config, so no signature churn. A no-snapshot journey overlays nothing → byte-identical
(golden matrix gate).

## WRITERS — competing-copy creators (Commit 5)
| Writer | file | Decision |
| -- | -- | -- |
| `restampBrand` | routes/workflows.ts | **material stamps REMOVED** (deliverables/timeline/rewardDescription). Brand presentation + shipsPhysicalProduct RETAINED. |
| `stampRewardFromNegotiation` | routes/workflows.ts | **REVERSED → strips** commissionRate off CONTENT_BRIEF/REWARD_SETUP (was copying it). |
| campaign create-stamp | routes/campaigns.ts:~441 | **material stamps REMOVED**; brand + shipsPhysicalProduct kept. |
| `stampOutreachDerivedFields` | routes/workflows.ts | **KEPT** — campaignName/collaborationType/offerSummary are presentation/derived, workflow-owned. |

## READERS — every active material-term consumer (Commits 2-4)
| Consumer | file | Source now | Notes |
| -- | -- | -- | -- |
| `buildNegotiationRequest` (the agent decision) | providers.ts | effectiveConfig (snapshot band+commission) | via negotiation.ts seam |
| `guardConstraintsFromConfig` ×3 | guards/outputGuard.ts | effectiveConfig | parity with the request |
| H1 no-ceiling backstop | executors/negotiation.ts | effective band (relocated post-build) | reads snapshot band |
| `describeDeal` (offer/counter copy) | executors/negotiation.ts | effectiveConfig | |
| contentBrief | executors/contentBrief.ts | pinned terms snapshot overlay; integrity→MANUAL_REVIEW | fee from creator history |
| rewardSetup | executors/rewardSetup.ts | pinned terms snapshot overlay | |
| operatorHandoff | executors/operatorHandoff.ts | terms overlay (public); band stays nodeGraph (follow-up) | |
| brandApproval | executors/brandApproval.ts | terms overlay (public); band stays nodeGraph (follow-up) | |
| partnership commission | executors/partnership.ts | pinned snapshot publicCommissionRate preferred | ledger; primary path is persisted event (already snapshot-sourced) |
| initialOutreach | executors/initialOutreach.ts | terms overlay (public); no gate on integrity | not contract-forming |
| followUp | executors/followUp.ts | mergeCampaignFallback (unchanged) | no material terms (brand-presentation reminder) |
| partnership `mintFeeObligation` | executors/partnership.ts | resolveAgreedFee(events) | SAFE — event-sourced, not config |
| manualQueue terms display | routes/manualQueue.ts | persisted DealHandoff row | SAFE — not config |
| **Python /negotiate + /draft** | agent/ | supplied TS projections | SAFE — opens no DB, reads no campaign state (verified) |

## shipsPhysicalProduct — retained compat (removal → PLU-144)
Read directly off nodeGraph by two consumers NOT yet snapshot-wired:
- `executors/paymentInfo.ts:141` (`config["shipsPhysicalProduct"]`) — shipping-address collection.
- `routes/payment.ts:93 shipsPhysicalProductOf()` — hosted payout-page shipping field.

Its stamp is deliberately KEPT so these keep working. It's a campaign-derived boolean
(not a negotiable term), snapshot has it in `detailsSnapshot.shipsPhysicalProduct`.
**Removal condition:** PLU-144 cuts both readers over to the pinned snapshot, then the
stamp is removed. Owner: PLU-144.

## Caches
- Brief parse cache (`briefKnowledge.ts`) keys `ref::parserVersion::parseMode` — the
  parsed text is a pure function of the PDF ref, and conflicts are re-checked per-instance
  at assemble time → snapshot-safe. No change needed.
- Conversation summary — narrative-only, no money terms → safe.

## Observability (Commit 2)
`ContextRecord` (folded onto NEGOTIATION_TURN) records `termsSnapshotId`,
`policySnapshotId` (authorized purposes only), `legacyFallbackUsed` (terms absent),
`bandLegacyFallback` (policy absent), `termsSource` (`snapshot` | `legacy_nodegraph`),
`integrityFailureReason` — IDs/labels only, never private values. Operators can trace
which authority a runtime decision used.

## Compatibility path (the ONLY sanctioned legacy path)
A creator journey with NO pinned snapshot reads its own nodeGraph via the resolver's
per-field config fallback. It never overrides a valid snapshot, is observable
(`termsSource=legacy_nodegraph` / `bandLegacyFallback=true`), and fails safely (a
mis-pinned snapshot → MANUAL_REVIEW, never a silent config read). **Removal / backfill
of existing no-snapshot journeys → PLU-144 (4a).**

## Out of scope (tracked elsewhere)
- Backfill of existing campaigns + production cutover → **PLU-144**.
- operatorHandoff/brandApproval private-BAND swap (they show a range; keep floor/preferred
  out) → tracked follow-up.
- shipsPhysicalProduct snapshot cutover → **PLU-144**.
- Partnership vs Execution long-term snapshot ownership → **PLU-119**.
