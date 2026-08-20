import type { JsonObject } from "../../db/schema.js";
import { findPaymentInfoByInstance } from "../../db/index.js";
import type { ExecutionContext, NodeResult, EmailAttachment } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { resolvePartnership } from "./partnership.js";
import { readStoredFile } from "../../storage/localFileStorage.js";
import { sendOnce } from "./idempotentSend.js";
import { renderContentBriefEmail } from "./contentBriefEmail.js";
import { resolveKnowledgeField } from "../knowledgePrecedence.js";
import { resolvePaymentToken } from "./paymentInfo.js";
import { paymentFormLink } from "./paymentEmail.js";
import { scanOutboundDraft, guardConstraintsFromConfig } from "../guards/outputGuard.js";
import {
  blockedByGuard,
  blockedByMissingBrand,
  blockedByAttributionMint,
  blockedBySnapshotIntegrity,
  blockedByCampaignBriefMismatch,
  blockedByMissingFinalAgreement,
  blockedByMissingFixedFee,
  blockedByIncompleteDeliverables,
} from "./guardEscalation.js";
import { resolveBrandName } from "../campaignContext.js";
import { loadPinnedTermsSnapshotForExecutor } from "../../db/campaignSnapshots.js";
import { resolveEffectiveNegotiationConfig } from "../effectiveTerms.js";
// PLU-143: the two canonical creator-specific/shared-obligation sources this
// executor now reads from — see docs/plu-143-content-brief-final-agreement-plan.md.
import { resolveCurrentCampaignBriefForInstance } from "../../db/campaignBriefValidation.js";
import type { CampaignBriefMismatchCategory } from "../../db/campaignBriefValidation.js";
import {
  findFinalAgreementByInstance,
  recordContentBriefGeneration,
} from "../../db/finalAgreements.js";
import { validateDeliverables } from "../../domain/deliverablesValidator.js";
import { formatDeliverablesForCreator } from "../../domain/deliverablesFormat.js";

// ---------------------------------------------------------------------------
// Content Brief executor (merged post-negotiation node)
// ---------------------------------------------------------------------------
// This is the SINGLE node that runs after a successful negotiation. It merges
// what used to be three nodes (Reward Setup + Payment Info + Content Brief) into
// one, and has TWO phases:
//
//   SEND phase (state ACCEPTED — or legacy PAYMENT_RECEIVED, see below):
//     1. Resolve the finalized offer (agreed fee / commission / deliverables /
//        timeline) from the persisted NEGOTIATION_TURN history + config.
//     2. Mint (or reuse) the secure payout token + hosted-form link.
//     3. Load the campaign brief PDF and attach it.
//     4. Send ONE "Your Campaign Brief" email: finalized terms + payout link +
//        PDF, idempotently.
//     5. Transition ACCEPTED → PAYMENT_PENDING and WAIT for the form submission.
//
//   SUBMISSION phase (state PAYMENT_PENDING, handled by executeContentBriefSubmission):
//     After the creator submits the hosted payout form (routes/payment.ts →
//     runtime.handlePaymentSubmission persists it), mint the money ledger and
//     transition PAYMENT_PENDING → CONTENT_LINKS_PENDING (non-terminal), where the
//     instance waits for the creator's in-thread content-links reply.
//
// Legacy graphs (Reward Setup → Payment Info → Content Brief) still drive this
// node from PAYMENT_RECEIVED with a brief-only email (no offer block / payout
// link, since Payment Info already collected payout). That path is preserved by
// accepting PAYMENT_RECEIVED in the send phase and skipping the payout section.

/** First non-empty string among the candidates, else "". */
function str(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === "string" ? v.trim() : "";
}

export async function executeContentBrief(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, creator } = ctx;

  // PLU-137/138: this email is contract-forming, so its PUBLIC terms
  // (deliverables / timeline / public commission / reward) must come from the
  // pinned CampaignTermsSnapshot, not the stale nodeGraph config. Load the pinned
  // snapshot with integrity discipline (missing / cross-campaign → MANUAL_REVIEW,
  // never a silent config read) and overlay its public fields onto the config the
  // knowledge resolver reads. A no-snapshot (legacy) journey overlays nothing → the
  // existing config→negotiationConfig chain runs unchanged. The FEE stays
  // creator-history-sourced (resolveAgreedFee) — final-deal state, not a snapshot.
  const pinnedTerms = await loadPinnedTermsSnapshotForExecutor(instance, ctx.campaign?.id);
  if (pinnedTerms.integrityFailure) {
    return blockedBySnapshotIntegrity(node.type, pinnedTerms.integrityFailure.reason);
  }
  const effectiveTerms = pinnedTerms.terms
    ? resolveEffectiveNegotiationConfig({ termsSnapshot: pinnedTerms.terms, config: node.config })
    : undefined;
  const config = effectiveTerms?.config ?? node.config;

  // The merged flow enters on ACCEPTED (Content Brief directly follows negotiation).
  // With the brand-approval gate ON, the SEND phase is deferred until the brand
  // Approves — the route then steps this node from AWAITING_BRAND_APPROVAL, which
  // is treated identically to ACCEPTED here (send the merged brief + payout link,
  // park in PAYMENT_PENDING). Legacy graphs still enter on PAYMENT_RECEIVED
  // (Payment Info already collected payout); in that case we send a brief-only
  // email and complete immediately.
  const isMerged =
    instance.currentState === "ACCEPTED" ||
    instance.currentState === "AWAITING_BRAND_APPROVAL";
  const isLegacy = instance.currentState === "PAYMENT_RECEIVED";
  if (!isMerged && !isLegacy) {
    throw new Error(
      `CONTENT_BRIEF expects ACCEPTED, AWAITING_BRAND_APPROVAL or PAYMENT_RECEIVED state, got ${instance.currentState}`,
    );
  }

  // 1. Read the brand-supplied WORKFLOW configuration (behavior fields, not
  //    material terms — PLU-137/138 only cut over material terms; briefFileName/
  //    creatorNotes stay config-sourced same as before).
  const briefFileName = str(config, "briefFileName") || "campaign-brief.pdf";
  const creatorNotes = str(config, "creatorNotes");
  // Legacy default — overridden below for the merged flow once FinalAgreement
  // is loaded (PLU-143: creator-specific compensation, including the gift/
  // product blurb, is FinalAgreement's authority for an accepted journey,
  // never resolveKnowledgeField/config).
  const legacyRewardDescriptionR = resolveKnowledgeField("rewardDescription", {
    workflowConfig: config["rewardDescription"],
  });
  let rewardDescription =
    typeof legacyRewardDescriptionR.value === "string" ? legacyRewardDescriptionR.value.trim() : "";

  // 2. Resolve the brand. L4 (#14): resolve from config → campaign; if neither
  //    has it, route to MANUAL_REVIEW (clean one-way handoff) for a human to fix
  //    the config rather than email the creator "your brand". runtime emails the
  //    brand an FYI keyed on missing_brand_name.
  const brandName = resolveBrandName(config, ctx.campaign);
  if (brandName === undefined) {
    return blockedByMissingBrand(ctx.node.type);
  }

  // 3. In the merged flow, resolve the canonical FinalAgreement (PLU-169) for
  //    creator-specific accepted compensation + deliverables, and the
  //    campaign-brief attachment (PLU-143 — see the plan doc's "Architecture
  //    decision" for why this branches on briefDeliveryMethod). The legacy
  //    flow (isLegacy) is unaffected: it predates FinalAgreement entirely and
  //    never resolves finalized terms (brief-only email, briefFileRef exactly
  //    as before).
  let fixedFee: number | undefined;
  let commissionRate: number | undefined;
  let deliverableLines: string[] = [];
  let timeline: string | undefined;
  let formLink = "";
  let token: string | undefined;
  let attachment: EmailAttachment;
  let contentBriefProvenance:
    | { campaignBriefId: string | null; assetRef: string; templateVersion: string }
    | undefined;

  if (isMerged) {
    // Per the issue's own "do not fall back" list: a missing row is a hard
    // block, never a resolveAgreedFee/nodeGraph replay. Reachable only for a
    // legacy instance that reached ACCEPTED before PLU-169 shipped and is
    // somehow re-driven through this node later (PLU-169 does not backfill
    // historical acceptances).
    const finalAgreement = await findFinalAgreementByInstance(instance.id);
    if (!finalAgreement) {
      return blockedByMissingFinalAgreement(node.type);
    }

    // Creator-specific accepted compensation — FinalAgreement is the SOLE
    // authority (the issue's own "final agreement is the authority for
    // creator-specific accepted deliverables" rule). finalFeeCents is
    // cents; every other consumer of `fixedFee` in this file (the email
    // template, the output-guard fee allowlist) expects dollars, matching
    // how `proposedRate` is dollars everywhere upstream of PLU-169's own
    // cents conversion at write time.
    fixedFee = finalAgreement.finalFeeCents !== null ? finalAgreement.finalFeeCents / 100 : undefined;
    commissionRate = finalAgreement.finalCommissionRate ?? undefined;
    timeline = finalAgreement.finalTimeline ?? undefined;
    rewardDescription = finalAgreement.finalGiftProductDescription ?? "";

    // Frozen CampaignDetails copy from the pinned snapshot — used below for
    // the brief-attachment branch (deliberately NEVER falls back to live
    // CampaignDetails — see that block's own comment).
    const detailsSnapshot = pinnedTerms.terms?.detailsSnapshot as Record<string, unknown> | undefined;

    // Review fix: an ACCEPT turn with no numeric proposedTerms.rate persists
    // finalFeeCents as null — legitimate for a pure-AFFILIATE/GIFT_ONLY deal,
    // but a genuine bug for a campaign whose type says a fixed fee is owed
    // (PAID/HYBRID, mirroring validateCompensationReadiness's own `needsFee`
    // rule in db/campaigns.ts). Never mint a payout-form link and state
    // "Fixed Fee: the agreed fee" for an amountless agreement — escalate
    // instead, before any email drafts or the payout token is minted.
    // Unlike briefDeliveryMethod below, this DOES fall back to live
    // campaignDetails for a legacy no-snapshot journey — campaignType isn't a
    // material negotiated term the snapshot exists to freeze, just a
    // classification, and skipping this guard entirely for every no-snapshot
    // legacy instance would defeat its purpose.
    const campaignType = detailsSnapshot?.["campaignType"] ?? ctx.campaignDetails?.campaignType;
    const needsFixedFee = campaignType === "PAID" || campaignType === "HYBRID";
    if (needsFixedFee && fixedFee === undefined) {
      return blockedByMissingFixedFee(node.type);
    }

    // Deliverable projection contract: consume the COMPLETE finalDeliverables
    // array, unmodified — no delta reapplication (nothing upstream stores one
    // in this phase), no partial-package fallback. Missing/empty/invalid
    // blocks safely rather than rendering "To be finalized".
    const deliverablesResult = validateDeliverables(finalAgreement.finalDeliverables ?? []);
    if (!deliverablesResult.ok || deliverablesResult.deliverables.length === 0) {
      return blockedByIncompleteDeliverables(
        node.type,
        deliverablesResult.ok ? "finalDeliverables is empty" : deliverablesResult.error,
      );
    }
    deliverableLines = formatDeliverablesForCreator(deliverablesResult.deliverables);

    // The attached document — branch on the PINNED snapshot's own
    // briefDeliveryMethod (frozen with the rest of CampaignDetails at
    // launch; never live CampaignDetails). "own_doc" (or unset/legacy, since
    // this field predates this ticket) keeps the brand's manually-uploaded
    // PDF exactly as before; "pluvus_builder" attaches the PLU-142-resolved
    // rendered CampaignBrief instead.
    const briefDeliveryMethod = detailsSnapshot?.["briefDeliveryMethod"];

    if (briefDeliveryMethod === "pluvus_builder") {
      const briefResult = await resolveCurrentCampaignBriefForInstance(instance.id);
      if (briefResult.status !== "CURRENT") {
        const IDENTITY_MISMATCH_CATEGORIES = new Set<CampaignBriefMismatchCategory>([
          "NO_CAMPAIGN",
          "NO_PINNED_SNAPSHOT",
          "SNAPSHOT_MISMATCH",
          "CROSS_CAMPAIGN",
        ]);
        if (briefResult.mismatchCategory && IDENTITY_MISMATCH_CATEGORIES.has(briefResult.mismatchCategory)) {
          // A real identity/integrity problem — no retry fixes this.
          return blockedByCampaignBriefMismatch(node.type, briefResult);
        }
        // The asset just isn't ready yet (NO_CURRENT_BRIEF/ASSET_UNAVAILABLE/
        // DATA_INCOMPLETE) — resolveCurrentCampaignBriefForInstance already
        // triggered a regeneration. Throw so the engine's own retry re-attempts
        // later, same pattern the missing-briefFileRef check below already
        // uses, rather than escalating a transient state to a human.
        throw new Error(
          `CONTENT_BRIEF for ${instance.id}: campaign brief not yet ready ` +
            `(status=${briefResult.status}, category=${briefResult.mismatchCategory ?? "none"})`,
        );
      }
      const brief = briefResult.brief;
      if (!brief || !brief.renderedAssetRef) {
        // Defensive — getCurrentReadyCampaignBrief()'s own CURRENT contract
        // guarantees both are set; should be unreachable.
        throw new Error(
          `CONTENT_BRIEF for ${instance.id}: CURRENT CampaignBrief result has no renderedAssetRef`,
        );
      }
      const content = await readStoredFile(brief.renderedAssetRef);
      attachment = { filename: "campaign-brief.pdf", contentType: "application/pdf", content };
      contentBriefProvenance = {
        campaignBriefId: brief.id,
        assetRef: brief.renderedAssetRef,
        templateVersion: brief.templateVersion,
      };
    } else {
      const briefFileRef = str(config, "briefFileRef");
      // The Campaign Brief PDF is required (enforced at publish/launch
      // validation); fail loudly if it's somehow missing at runtime rather
      // than sending a brief email with no brief. A thrown error preserves
      // the engine's retry/error handling — the same behavior every other
      // executor relies on.
      if (!briefFileRef) {
        throw new Error(
          `CONTENT_BRIEF for ${instance.id} has no campaign brief PDF configured (briefFileRef)`,
        );
      }
      const content = await readStoredFile(briefFileRef);
      attachment = { filename: briefFileName, contentType: "application/pdf", content };
      contentBriefProvenance = {
        campaignBriefId: null,
        assetRef: briefFileRef,
        templateVersion: "brand_uploaded",
      };
    }

    token = await resolvePaymentToken(instance.id);
    formLink = paymentFormLink(token);
  } else {
    // Legacy (PAYMENT_RECEIVED): brief-only email, unchanged — briefFileRef
    // exactly as before, no FinalAgreement/CampaignBrief involvement.
    const briefFileRef = str(config, "briefFileRef");
    if (!briefFileRef) {
      throw new Error(
        `CONTENT_BRIEF for ${instance.id} has no campaign brief PDF configured (briefFileRef)`,
      );
    }
    const content = await readStoredFile(briefFileRef);
    attachment = { filename: briefFileName, contentType: "application/pdf", content };
  }

  // 5. Render the email. The renderer includes the offer block + payout link only
  //    when formLink is non-empty (merged flow); legacy sends the brief-only body.
  const draft = {
    ...renderContentBriefEmail({
      creatorName: creator.name,
      brandName,
      formLink,
      fixedFee,
      commissionRate,
      deliverableLines,
      timeline,
      creatorNotes,
      rewardDescription,
    }),
    attachments: [attachment],
  };

  // 6. The merged email states a dollar figure — scan the rendered draft for a
  //    leaked floor/ceiling before sending. The agreed fee is the number we mean
  //    to present, so it's allowlisted (parity with executeRewardSetup).
  if (isMerged) {
    const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(config, fixedFee));
    if (!guard.ok) {
      return blockedByGuard(instance.negotiationRound, guard.hits);
    }
  }

  // 7. Idempotent send keyed on (instance, content_brief) — a re-run of the
  //    ACCEPTED auto-chain (e.g. a BullMQ retry) won't double-send the email,
  //    re-attach the PDF, or re-mint the token (resolvePaymentToken is idempotent).
  await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `content-brief:${instance.id}`,
    undefined, // deps — default
    undefined, // recipient — creator
    ctx.campaign?.name, // Gmail Campaign Labels (§6.3)
  );

  // 8a. Merged flow: enter the PAYMENT_PENDING waiting state and stay on THIS node
  //     so the hosted-form submission resumes here. NOT terminal — no completedAt.
  if (isMerged) {
    // PLU-143: record which document was actually attached, on the same
    // FinalAgreement row recordFinalAgreementOnce inserted at accept time. A
    // second write against an existing row (see recordContentBriefGeneration's
    // own doc comment) — safe to repeat on a retried step.
    const generatedAt = new Date();
    if (contentBriefProvenance) {
      await recordContentBriefGeneration(instance.id, { ...contentBriefProvenance, generatedAt });
    }
    return {
      nextState: "PAYMENT_PENDING",
      nextNodeId: node.id,
      eventType: "PAYMENT_INFO_SENT",
      eventPayload: {
        ...(token ? { token, formLink } : {}),
        ...(fixedFee !== undefined ? { fixedFee } : {}),
        ...(commissionRate !== undefined ? { commission: commissionRate } : {}),
        ...(contentBriefProvenance ? { contentBriefGeneration: contentBriefProvenance } : {}),
      } as JsonObject,
    };
  }

  // 8b. Legacy flow: Content Brief is the terminal node — stamp completedAt.
  return {
    nextState: "CONTENT_BRIEF_SENT",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "CONTENT_BRIEF_SENT",
    eventPayload: {
      briefFileName,
    } as JsonObject,
  };
}

// ---------------------------------------------------------------------------
// Content Brief — payout-form submission handling (merged flow)
// ---------------------------------------------------------------------------
// Runs when the creator has submitted the hosted payout form while the merged
// Content Brief node is parked in PAYMENT_PENDING. The submission itself
// (validating + persisting the payout fields) is done by the payment route before
// this executor runs; by the time this runs the PaymentInfo row is already
// PAYMENT_RECEIVED. It mints the money ledger (Partnership + fee Obligation) and
// then parks the instance on the non-terminal CONTENT_LINKS_PENDING waiting state
// (there is no separate PAYMENT_RECEIVED hop in the merged flow, since Content
// Brief already sent the brief up-front). The instance then waits for the creator
// to reply in-thread with their content links (handled by executeContentLinksReply).

export async function executeContentBriefSubmission(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node } = ctx;
  const config = node.config;

  if (instance.currentState !== "PAYMENT_PENDING") {
    throw new Error(
      `CONTENT_BRIEF submission expects PAYMENT_PENDING state, got ${instance.currentState}`,
    );
  }

  const payment = await findPaymentInfoByInstance(instance.id);
  if (!payment || payment.status !== "PAYMENT_RECEIVED") {
    // Defensive: the route persists PAYMENT_RECEIVED before stepping, so this
    // should not happen. If it does, stay pending rather than advancing on
    // incomplete data.
    throw new Error(
      `CONTENT_BRIEF submission for ${instance.id} has no received PaymentInfo row`,
    );
  }

  const briefFileName = str(config, "briefFileName") || "campaign-brief.pdf";

  // Phase 1: mint (or reuse) the Partnership row + fee Obligation (the money
  // ledger) and send the welcome email. BUG-E2: this mint is what records the
  // money the brand owes the creator. If it fails (throws, or resolvePartnership
  // returns null on a DB blip), we must NOT fall through to the success terminal
  // — that would "complete" the deal with no ledger row and no recovery path
  // (CONTENT_BRIEF_SENT is terminal + excluded from RECONCILE_STATES). Route to
  // MANUAL_REVIEW instead so a human can re-run and complete the mint. The
  // creator's payout data is already persisted (PaymentInfo is PAYMENT_RECEIVED),
  // so nothing is lost and the node is safe to re-run. (An internal welcome-email
  // failure inside resolvePartnership is swallowed there and still returns the
  // partnership, so it does NOT trip this escalation — only a real mint failure.)
  let partnership;
  try {
    partnership = await resolvePartnership(ctx, email);
  } catch (err) {
    console.error("[contentBrief] resolvePartnership threw — escalating to MANUAL_REVIEW", err);
    return blockedByAttributionMint(node.type);
  }
  if (!partnership) {
    console.error(
      `[contentBrief] resolvePartnership returned null for ${instance.id} — escalating to MANUAL_REVIEW`,
    );
    return blockedByAttributionMint(node.type);
  }

  // The payout submission no longer completes the run. Instead of landing on the
  // CONTENT_BRIEF_SENT terminal, park on the non-terminal CONTENT_LINKS_PENDING
  // waiting state (staying on THIS node) so the creator can reply in-thread with
  // their content links, which the content-links reply handler then processes.
  // The ledger mint above (Partnership + fee Obligation) is unchanged — the money
  // behavior is identical; only the post-mint parking target moved. No completedAt
  // (this is a waiting state, not the end of the run).
  return {
    nextState: "CONTENT_LINKS_PENDING",
    nextNodeId: node.id,
    eventType: "CONTENT_BRIEF_SENT",
    eventPayload: {
      briefFileName,
      method: payment.method,
      ...(payment.country ? { country: payment.country } : {}),
    } as JsonObject,
  };
}
