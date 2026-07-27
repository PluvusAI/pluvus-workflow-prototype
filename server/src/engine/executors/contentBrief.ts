import type { JsonObject } from "../../db/schema.js";
import { listEventsByInstance, findPaymentInfoByInstance } from "../../db/index.js";
import type { ExecutionContext, NodeResult, EmailAttachment } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { resolvePartnership } from "./partnership.js";
import { readStoredFile } from "../../storage/localFileStorage.js";
import { sendOnce } from "./idempotentSend.js";
import { renderContentBriefEmail } from "./contentBriefEmail.js";
import { resolveAgreedFee } from "./agreedFee.js";
import { resolveKnowledgeField, type SourceLabel } from "../knowledgePrecedence.js";
import { resolvePaymentToken } from "./paymentInfo.js";
import { paymentFormLink } from "./paymentEmail.js";
import { scanOutboundDraft, guardConstraintsFromConfig } from "../guards/outputGuard.js";
import { blockedByGuard, blockedByMissingBrand, blockedByAttributionMint } from "./guardEscalation.js";
import { resolveBrandName } from "../campaignContext.js";

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
  const { instance, node, nodeGraph, creator } = ctx;
  const config = node.config;

  // The merged flow enters on ACCEPTED (Content Brief directly follows negotiation).
  // Legacy graphs still enter on PAYMENT_RECEIVED (Payment Info already collected
  // payout); in that case we send a brief-only email and complete immediately.
  const isMerged = instance.currentState === "ACCEPTED";
  const isLegacy = instance.currentState === "PAYMENT_RECEIVED";
  if (!isMerged && !isLegacy) {
    throw new Error(
      `CONTENT_BRIEF expects ACCEPTED or PAYMENT_RECEIVED state, got ${instance.currentState}`,
    );
  }

  // 1. Read the brand-supplied configuration.
  const briefFileRef = str(config, "briefFileRef");
  const briefFileName = str(config, "briefFileName") || "campaign-brief.pdf";
  const creatorNotes = str(config, "creatorNotes");
  const rewardDescription = str(config, "rewardDescription");

  // The Campaign Brief PDF is required (enforced at publish/launch validation);
  // fail loudly if it's somehow missing at runtime rather than sending a brief
  // email with no brief. A thrown error preserves the engine's retry/error
  // handling — the same behavior every other executor relies on.
  if (!briefFileRef) {
    throw new Error(
      `CONTENT_BRIEF for ${instance.id} has no campaign brief PDF configured (briefFileRef)`,
    );
  }

  // 2. Load the uploaded PDF from local storage and build the attachment.
  const content = await readStoredFile(briefFileRef);
  const attachment: EmailAttachment = {
    filename: briefFileName,
    contentType: "application/pdf",
    content,
  };

  // 3. Resolve the brand. L4 (#14): resolve from config → campaign; if neither
  //    has it, route to MANUAL_REVIEW (clean one-way handoff) for a human to fix
  //    the config rather than email the creator "your brand". runtime emails the
  //    brand an FYI keyed on missing_brand_name.
  const brandName = resolveBrandName(config, ctx.campaign);
  if (brandName === undefined) {
    return blockedByMissingBrand(ctx.node.type);
  }

  // 4. In the merged flow, assemble the finalized offer + mint the payout link so
  //    the single email carries the terms and the form. In the legacy flow payout
  //    is already collected, so we send the brief-only email (no offer/link).
  let fixedFee: number | undefined;
  let commissionRate: number | undefined;
  let deliverables: string | undefined;
  let timeline: string | undefined;
  let formLink = "";
  let token: string | undefined;
  // PLU-82 (§4.6): the winning-source label per finalized term, populated in the
  // merged branch below (the legacy brief-only flow resolves no terms). Debug
  // metadata for the event payload only — never a money/term input.
  const resolvedSources: Record<string, SourceLabel> = {};

  if (isMerged) {
    // The negotiation commission is stamped onto THIS node's config at save/publish
    // (stampRewardFromNegotiation). Read the NEGOTIATION node as a defensive
    // fallback for versions published before the stamp (or direct-created instances).
    const negotiationConfig =
      nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
    const events = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });
    fixedFee = resolveAgreedFee(events, negotiationConfig, config);
    // CRITICAL-3: the merged Content Brief email is contract-forming — it states
    // the fee + payout link the creator submits against. If no genuine agreed
    // rate was recorded (resolveAgreedFee returns undefined; the old code fell
    // back to the internal ceiling here), escalate to a human rather than email a
    // fabricated figure. Deterministic code must never invent a fee (PRINCIPLES.md).
    if (fixedFee === undefined) {
      return {
        nextState: "MANUAL_REVIEW",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "MANUAL_REVIEW_FLAGGED",
        eventPayload: { outcome: "ESCALATE", reason: "no_agreed_fee", node: node.type },
      };
    }
    // PLU-82 (§4.3): resolve through the documented precedence resolver instead of
    // the inline chains — byte-identical (invariant #3), golden-test locked. 2-tier
    // here (config → negotiationConfig, no campaign fallback), so campaignDefault
    // is omitted (undefined = skipped).
    const commission = resolveKnowledgeField("commissionRate", {
      workflowConfig: config["commissionRate"],
      negotiationState: negotiationConfig["commissionRate"],
    });
    commissionRate = commission.value as number | undefined;
    resolvedSources["commissionRate"] = commission.source;
    const deliverablesR = resolveKnowledgeField("deliverables", {
      workflowConfig: config["deliverables"],
      negotiationState: negotiationConfig["deliverables"],
    });
    deliverables = deliverablesR.value as string | undefined;
    resolvedSources["deliverables"] = deliverablesR.source;
    const timelineR = resolveKnowledgeField("timeline", {
      workflowConfig: config["timeline"],
      negotiationState: negotiationConfig["timeline"],
    });
    timeline = timelineR.value as string | undefined;
    resolvedSources["timeline"] = timelineR.source;

    token = await resolvePaymentToken(instance.id);
    formLink = paymentFormLink(token);
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
      deliverables,
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
    return {
      nextState: "PAYMENT_PENDING",
      nextNodeId: node.id,
      eventType: "PAYMENT_INFO_SENT",
      eventPayload: {
        ...(token ? { token, formLink } : {}),
        ...(fixedFee !== undefined ? { fixedFee } : {}),
        ...(commissionRate !== undefined ? { commission: commissionRate } : {}),
        // PLU-82 (§4.6): winning-source label per finalized term. Debug metadata only.
        resolvedSources,
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
