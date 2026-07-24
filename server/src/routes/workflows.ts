import { Router } from "express";
import type { Request, Response } from "express";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  findWorkflowById,
  updateWorkflow,
  findLatestVersion,
  listVersions,
  createVersion,
  nextVersionNumber,
} from "../db/workflows.js";
import {
  listInstancesByVersion,
  createInstance,
  findInstanceByCreatorAndVersion,
} from "../db/instances.js";
import { listCreators } from "../db/creators.js";
import { findCampaignById } from "../db/campaigns.js";
import { db } from "../db/drizzle.js";
import { isForeignKeyViolation, isUniqueViolation } from "../db/errors.js";
import {
  campaigns as campaignsTable,
  creators as creatorsTable,
  events as eventsTable,
  executionInstances,
  workflows as workflowsTable,
  type InputJsonValue,
} from "../db/schema.js";
import { enqueueNodeExecution } from "../workers/queues.js";
import { validateNodeGraph } from "../templates/index.js";
import { validateWorkflowGraph } from "../validation/graphValidation.js";
import { agentBaseUrl, agentPostJson } from "../adapters/agentServiceClient.js";
import { dealShape } from "../engine/dealDescription.js";
import { availableOutreachVariables } from "../engine/outreachVariables.js";

const router = Router();

// ---------------------------------------------------------------------------
// Unified validation — graph rules + legacy flat-list rules.
// ---------------------------------------------------------------------------
// The graph validator (Phase 17) reconstructs the workflow graph from the
// `_graph` sidecar (or order-implicit edges for legacy drafts) and enforces the
// full structural contract: one start, a terminal, no cycles/orphans/branches,
// phase ordering, and required config. We also run the legacy validator so any
// rule it caught that the graph model doesn't is still surfaced. The response
// keeps the historical `errors: string[]` shape AND adds structured `issues[]`.
function validateWorkflowNodes(
  nodesRaw: unknown,
  opts: { structuralOnly?: boolean } = {},
): {
  valid: boolean;
  errors: string[];
  issues: import("../validation/graphValidation.js").ValidationIssue[];
} {
  const graph = validateWorkflowGraph(nodesRaw, opts);
  const graphMessages = graph.errors.filter((e) => e.severity === "error").map((e) => e.message);
  // In structural-only mode (launch), the legacy validator's config-oriented
  // rules (content-brief PDF, etc.) are intentionally skipped — the immutable
  // published version already passed the full gate at publish time.
  if (opts.structuralOnly) {
    return { valid: graph.valid, errors: graphMessages, issues: graph.errors };
  }
  const legacy = validateNodeGraph(nodesRaw);
  const legacyOnly = legacy.errors.filter((m) => !graphMessages.includes(m));
  const errors = [...graphMessages, ...legacyOnly];
  return { valid: graph.valid && legacy.valid, errors, issues: graph.errors };
}

// ---------------------------------------------------------------------------
// Re-stamp the campaign brand into node configs.
// ---------------------------------------------------------------------------
// brandName/senderName are stamped into every node config at workflow creation
// (see POST /campaigns/:id/workflows) so {{brandName}} resolves and the
// negotiation agent signs off as the brand rather than its "Pluvus
// Partnerships" fallback. The builder's per-node config forms send a fresh
// config object on save, which can drop those keys — so we re-inject them here
// on every draft save. Existing non-empty values are preserved (a deliberate
// per-node override is never clobbered); only missing/blank values are filled.
function restampBrand(
  nodes: unknown,
  brand: string,
  brandDescription?: string | null,
  deliverables?: string | null,
  timeline?: string | null,
  rewardDescription?: string | null,
  shipsPhysicalProduct?: boolean,
): unknown {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as { config?: unknown; [k: string]: unknown };
    const config = (n.config && typeof n.config === "object" ? n.config : {}) as Record<
      string,
      unknown
    >;
    const hasBrand = typeof config["brandName"] === "string" && config["brandName"] !== "";
    const hasSender = typeof config["senderName"] === "string" && config["senderName"] !== "";
    const hasDesc = typeof config["brandDescription"] === "string" && config["brandDescription"] !== "";
    // deliverables/timeline are re-injected so the Reward Setup node (and the
    // negotiation copy) reliably see the brand-supplied scope even after the
    // builder's per-node forms round-trip a config that dropped them.
    const hasDeliverables = typeof config["deliverables"] === "string" && config["deliverables"] !== "";
    const hasTimeline = typeof config["timeline"] === "string" && config["timeline"] !== "";
    // rewardDescription is a free-text blurb mentioned across the email copy;
    // preserve-if-present like the other campaign fields. shipsPhysicalProduct
    // is a boolean flag that gates the payment form's shipping-address section;
    // it is authoritative from the campaign, so it OVERWRITES every save (a node
    // can't meaningfully override "does this campaign ship a product").
    const hasReward =
      typeof config["rewardDescription"] === "string" && config["rewardDescription"] !== "";
    return {
      ...n,
      config: {
        ...config,
        ...(hasBrand ? {} : { brandName: brand }),
        ...(hasSender ? {} : { senderName: brand }),
        ...(hasDesc || !brandDescription ? {} : { brandDescription }),
        ...(hasDeliverables || !deliverables ? {} : { deliverables }),
        ...(hasTimeline || !timeline ? {} : { timeline }),
        ...(hasReward || !rewardDescription ? {} : { rewardDescription }),
        ...(shipsPhysicalProduct ? { shipsPhysicalProduct: true } : { shipsPhysicalProduct: false }),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Mirror the negotiation commission onto the post-negotiation email node(s).
// ---------------------------------------------------------------------------
// The brand decides the commission % on the NEGOTIATION node. The node that
// emails the finalized commission — CONTENT_BRIEF in the merged flow, or the
// legacy REWARD_SETUP node — must always reflect the CURRENT negotiation value,
// not a stale copy. Unlike the brand fields above (preserve-if-present), this
// OVERWRITES the target node's commissionRate every save so editing the
// negotiation node keeps it in sync. Deliverables are already carried by
// restampBrand from the campaign; commission is the one field sourced from
// another node, so it's stamped here.
export function stampRewardFromNegotiation(nodes: unknown): unknown {
  if (!Array.isArray(nodes)) return nodes;

  const negotiation = nodes.find(
    (n): n is { type: string; config?: Record<string, unknown> } =>
      !!n && typeof n === "object" && (n as { type?: unknown }).type === "NEGOTIATION",
  );
  const negConfig = (negotiation?.config ?? {}) as Record<string, unknown>;
  const commission = negConfig["commissionRate"];
  // Only a positive number is a real commission; 0/absent means fixed-fee only,
  // in which case the target node should carry no commissionRate.
  const hasCommission = typeof commission === "number" && commission > 0;

  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as { type?: unknown; config?: unknown; [k: string]: unknown };
    if (n.type !== "REWARD_SETUP" && n.type !== "CONTENT_BRIEF") return node;
    const config = (n.config && typeof n.config === "object" ? n.config : {}) as Record<
      string,
      unknown
    >;
    // Drop any stale commissionRate, then set it iff the negotiation has one.
    const { commissionRate: _drop, ...rest } = config;
    return {
      ...n,
      config: {
        ...rest,
        ...(hasCommission ? { commissionRate: commission } : {}),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Stamp the outreach template's DERIVED placeholder sources onto the node.
// ---------------------------------------------------------------------------
// PLU-117: {{campaignName}}, {{collaborationType}}, {{offerSummary}} are not
// plain brand fields — campaignName comes off the campaign row, and the other
// two are derived from the NEGOTIATION deal shape. So the builder (palette /
// preview / AI availability) never saw their real values and they rendered
// blank. Stamp them onto the INITIAL_OUTREACH node config here on every save /
// publish so the builder resolves them exactly as the send path will.
//
// Unlike brand fields these are AUTHORITATIVE from the campaign/negotiation (an
// operator can't meaningfully override "what is this campaign's name"), so they
// OVERWRITE — and when a source is ABSENT the key is REMOVED, so an availability
// check based on "config has a non-empty value" correctly hides the placeholder.
export function stampOutreachDerivedFields(
  nodes: unknown,
  campaignName: string | null | undefined,
): unknown {
  if (!Array.isArray(nodes)) return nodes;

  const negotiation = nodes.find(
    (n): n is { type: string; config?: Record<string, unknown> } =>
      !!n && typeof n === "object" && (n as { type?: unknown }).type === "NEGOTIATION",
  );
  const shape = dealShape((negotiation?.config ?? {}) as Record<string, unknown>);

  const derived: Record<string, string> = {};
  if (typeof campaignName === "string" && campaignName.trim().length > 0) {
    derived["campaignName"] = campaignName;
  }
  if (shape) {
    derived["collaborationType"] = shape.type;
    derived["offerSummary"] = shape.summary;
  }

  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as { type?: unknown; config?: unknown; [k: string]: unknown };
    if (n.type !== "INITIAL_OUTREACH") return node;
    const config = (n.config && typeof n.config === "object" ? n.config : {}) as Record<
      string,
      unknown
    >;
    // Drop any stale derived keys, then set the ones we have a source for. A
    // dropped key (no source) means the placeholder is unavailable → not offered.
    const { campaignName: _c, collaborationType: _t, offerSummary: _o, ...rest } = config;
    return { ...n, config: { ...rest, ...derived } };
  });
}

// ---------------------------------------------------------------------------
// GET /workflows/:id — workflow detail with draftNodes + latest version
// ---------------------------------------------------------------------------

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const wfRows = await db
      .select({ workflow: workflowsTable, campaign: campaignsTable })
      .from(workflowsTable)
      .leftJoin(campaignsTable, eq(workflowsTable.campaignId, campaignsTable.id))
      .where(eq(workflowsTable.id, req.params["id"]!))
      .limit(1);
    const found = wfRows[0];
    if (!found) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    const wf = found.workflow;

    const latestVersion = await findLatestVersion(wf.id);

    res.json({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      status: wf.status,
      campaignId: wf.campaignId,
      campaign: found.campaign
        ? {
            id: found.campaign.id,
            name: found.campaign.name,
            brand: found.campaign.brand,
            // PLU-70: the enroll tab shows this as the pre-selected default and
            // lets the operator override it for the batch they're about to enroll.
            postAcceptanceMode: found.campaign.postAcceptanceMode,
          }
        : null,
      draftNodes: wf.draftNodes ?? [],
      latestVersion: latestVersion
        ? {
            id: latestVersion.id,
            version: latestVersion.version,
            publishedAt: latestVersion.publishedAt.toISOString(),
          }
        : null,
      createdAt: wf.createdAt.toISOString(),
      updatedAt: wf.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[workflows] get error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/outreach/template — AI-assisted TEMPLATE authoring (PLU-117)
// ---------------------------------------------------------------------------
// Setup-time ONLY. Helps the operator author/revise the ONE reusable outreach
// template that is later sent deterministically (placeholders only) to every
// creator. This is NEVER on the send path — executeInitialOutreach in manual mode
// still calls no AI. Brand/campaign/deal context is assembled SERVER-SIDE from the
// campaign row + the workflow's NEGOTIATION node, never trusted from the client
// (the client can only pass an instruction + the current subject/body it's
// revising). The supported placeholder list is the server's own allow-list so the
// model can only emit tokens we can actually resolve.

// Find a node of a given type in the draft node array (setup-time source).
function findDraftNode(
  nodes: unknown,
  type: string,
): { config?: Record<string, unknown> } | undefined {
  if (!Array.isArray(nodes)) return undefined;
  return nodes.find(
    (n): n is { type: string; config?: Record<string, unknown> } =>
      !!n && typeof n === "object" && (n as { type?: unknown }).type === type,
  );
}

/** The minimal campaign shape the outreach-template context reads. */
export interface OutreachTemplateCampaignFacts {
  brand?: string | null;
  brandDescription?: string | null;
  name?: string | null;
  deliverables?: string | null;
  timeline?: string | null;
  rewardDescription?: string | null;
}

/**
 * Assemble the brand/campaign/deal context sent to the agent's template route,
 * SERVER-SIDE from the campaign row + the workflow's NEGOTIATION node. This is the
 * trust boundary: the client never supplies brand facts — only reliably-available
 * fields are included (PLU-117), and empty/absent fields are omitted so the model
 * never treats a blank as a fact. Pure + exported so it's unit-testable without a
 * DB or a live agent.
 */
export function buildOutreachTemplateContext(
  campaign: OutreachTemplateCampaignFacts | null | undefined,
  draftNodes: unknown,
): { brandContext: Record<string, unknown>; allowedPlaceholders: string[] } {
  const negConfig = findDraftNode(draftNodes, "NEGOTIATION")?.config ?? {};
  const shape = dealShape(negConfig);

  const brandContext: Record<string, unknown> = {};
  const put = (k: string, v: unknown): void => {
    if (typeof v === "string" && v.trim().length > 0) brandContext[k] = v;
  };
  put("brandName", campaign?.brand);
  put("senderName", campaign?.brand);
  put("brandDescription", campaign?.brandDescription);
  put("campaignName", campaign?.name);
  put("deliverables", campaign?.deliverables);
  put("timeline", campaign?.timeline);
  put("rewardDescription", campaign?.rewardDescription);
  if (shape) {
    brandContext["collaborationType"] = shape.type;
    brandContext["offerSummary"] = shape.summary;
  }

  // PLU-117: give the AI ONLY the placeholders that are AVAILABLE for this
  // campaign — always-available ones plus the config-sourced ones the brand
  // actually supplied (which are exactly the keys we just put on brandContext).
  // So the AI can never emit {{campaignName}} when there's no campaign name, etc.
  const allowedPlaceholders = availableOutreachVariables(brandContext).map(
    (v) => `{{${v.name}}}`,
  );
  return { brandContext, allowedPlaceholders };
}

router.post("/:id/outreach/template", async (req: Request, res: Response) => {
  try {
    const wfRows = await db
      .select({ workflow: workflowsTable, campaign: campaignsTable })
      .from(workflowsTable)
      .leftJoin(campaignsTable, eq(workflowsTable.campaignId, campaignsTable.id))
      .where(eq(workflowsTable.id, req.params["id"]!))
      .limit(1);
    const found = wfRows[0];
    if (!found) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    const { workflow: wf, campaign } = found;

    // The client may pass ONLY an instruction and the current copy it is revising.
    // Everything factual (brand/campaign/deal) is assembled here so a client can't
    // inject brand facts the operator never approved.
    const body = (req.body ?? {}) as {
      instruction?: unknown;
      currentSubject?: unknown;
      currentBody?: unknown;
    };
    const instruction = typeof body.instruction === "string" ? body.instruction : undefined;
    const currentSubject = typeof body.currentSubject === "string" ? body.currentSubject : undefined;
    const currentBody = typeof body.currentBody === "string" ? body.currentBody : undefined;

    // Assemble brand/campaign/deal context server-side (trust boundary).
    const { brandContext, allowedPlaceholders } = buildOutreachTemplateContext(
      campaign,
      wf.draftNodes,
    );

    const result = await agentPostJson(agentBaseUrl(), "/outreach/template", {
      brandContext,
      allowedPlaceholders,
      ...(instruction ? { instruction } : {}),
      ...(currentSubject ? { currentSubject } : {}),
      ...(currentBody ? { currentBody } : {}),
    });

    res.json({
      subject: typeof result["subject"] === "string" ? result["subject"] : "",
      body: typeof result["body"] === "string" ? result["body"] : "",
      alternateSubjects: Array.isArray(result["alternateSubjects"]) ? result["alternateSubjects"] : [],
      flaggedPlaceholders: Array.isArray(result["flaggedPlaceholders"])
        ? result["flaggedPlaceholders"]
        : [],
    });
  } catch (err) {
    // The agent maps an injection-flagged instruction to a 400; surface that as a
    // 400 so the builder can show "rephrase the instruction" rather than a generic
    // failure. Everything else is a 502 (agent unavailable / generation failed).
    const status = (err as { status?: number }).status;
    if (status === 400) {
      res.status(400).json({ error: "instruction looks like a prompt-injection attempt" });
      return;
    }
    console.error("[workflows] outreach template error:", err);
    res.status(502).json({ error: "outreach template generation failed" });
  }
});

// ---------------------------------------------------------------------------
// PUT /workflows/:id/metadata — update name / description
// ---------------------------------------------------------------------------

router.put("/:id/metadata", async (req: Request, res: Response) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    const updated = await updateWorkflow(wf.id, {
      name: name.trim(),
      ...(description !== undefined
        ? { description: typeof description === "string" ? description.trim() || null : null }
        : {}),
    });
    res.json({ id: updated.id, name: updated.name, description: updated.description });
  } catch (err) {
    console.error("[workflows] metadata update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /workflows/:id/draft — replace the full draftNodes array
// ---------------------------------------------------------------------------

router.put("/:id/draft", async (req: Request, res: Response) => {
  const { nodes } = req.body as { nodes?: unknown };

  const validation = validateWorkflowNodes(nodes);
  // For draft saves we allow partial/empty graphs (soft validation warnings only).
  // We just store what the builder sends as-is unless it's malformed JSON.
  if (!Array.isArray(nodes)) {
    res.status(400).json({ error: "nodes must be an array" });
    return;
  }

  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    // Re-inject the campaign brand into node configs so it survives builder
    // edits (the per-node forms can drop brandName/senderName on save).
    let nodesToSave: unknown = nodes;
    if (wf.campaignId) {
      const campaign = await findCampaignById(wf.campaignId);
      if (campaign) {
        nodesToSave = restampBrand(
          nodes,
          campaign.brand,
          campaign.brandDescription,
          campaign.deliverables,
          campaign.timeline,
          campaign.rewardDescription,
          campaign.shipsPhysicalProduct,
        );
        // PLU-117: stamp campaignName + deal-shape sources onto the outreach node
        // so the builder palette/preview/AI see their real values (or hide them
        // when absent). Depends on the NEGOTIATION node, so run after restamp.
        nodesToSave = stampOutreachDerivedFields(nodesToSave, campaign.name);
      }
    }
    // Mirror the brand's negotiation commission onto the Reward Setup node so the
    // builder + runtime always show the current value (independent of campaign).
    nodesToSave = stampRewardFromNegotiation(nodesToSave);

    const updated = await updateWorkflow(wf.id, {
      draftNodes: nodesToSave as InputJsonValue,
    });

    res.json({
      id: updated.id,
      draftNodes: updated.draftNodes,
      valid: validation.valid,
      validationErrors: validation.errors,
      validationIssues: validation.issues,
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[workflows] draft update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/validate — validate draftNodes without publishing
// ---------------------------------------------------------------------------

router.post("/:id/validate", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    const validation = validateWorkflowNodes(wf.draftNodes);
    res.json({ valid: validation.valid, errors: validation.errors, issues: validation.issues });
  } catch (err) {
    console.error("[workflows] validate error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/publish — create an immutable WorkflowVersion
// ---------------------------------------------------------------------------

router.post("/:id/publish", async (req: Request, res: Response) => {
  const { notes } = req.body as { notes?: string };

  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const validation = validateWorkflowNodes(wf.draftNodes);
    if (!validation.valid) {
      res.status(422).json({
        error: "workflow has validation errors",
        validationErrors: validation.errors,
        validationIssues: validation.issues,
      });
      return;
    }

    // Re-stamp brand fields (including brandDescription) at publish time so the
    // immutable snapshot always carries the campaign's brand context even if the
    // builder's draft-save didn't stamp it (e.g. workflows created before
    // brandDescription was added, or configs edited in the builder).
    let nodeGraphToPublish: InputJsonValue = wf.draftNodes as InputJsonValue;
    if (wf.campaignId) {
      const campaign = await findCampaignById(wf.campaignId);
      if (campaign) {
        nodeGraphToPublish = restampBrand(
          wf.draftNodes,
          campaign.brand,
          campaign.brandDescription,
          campaign.deliverables,
          campaign.timeline,
          campaign.rewardDescription,
          campaign.shipsPhysicalProduct,
        ) as InputJsonValue;
        // PLU-117: freeze the derived outreach placeholder sources (campaignName +
        // deal shape) onto the immutable version, matching what the builder showed.
        nodeGraphToPublish = stampOutreachDerivedFields(
          nodeGraphToPublish,
          campaign.name,
        ) as InputJsonValue;
      }
    }
    // Freeze the current negotiation commission onto the Reward Setup node so the
    // immutable version carries the finalized value the deal was published with.
    nodeGraphToPublish = stampRewardFromNegotiation(
      nodeGraphToPublish,
    ) as InputJsonValue;

    const versionNumber = await nextVersionNumber(wf.id);
    const version = await createVersion({
      version: versionNumber,
      nodeGraph: nodeGraphToPublish,
      publishedAt: new Date(),
      workflowId: wf.id,
    });

    await updateWorkflow(wf.id, { status: "PUBLISHED" });

    res.status(201).json({
      versionId: version.id,
      version: version.version,
      publishedAt: version.publishedAt.toISOString(),
      notes: notes ?? null,
    });
  } catch (err) {
    console.error("[workflows] publish error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /workflows/:id/versions — list published versions
// ---------------------------------------------------------------------------

router.get("/:id/versions", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const versions = await listVersions(wf.id);
    const countsRaw =
      versions.length > 0
        ? await db
            .select({
              workflowVersionId: executionInstances.workflowVersionId,
              _count: count(),
            })
            .from(executionInstances)
            .where(
              inArray(
                executionInstances.workflowVersionId,
                versions.map((v) => v.id),
              ),
            )
            .groupBy(executionInstances.workflowVersionId)
        : [];
    const countMap = new Map(countsRaw.map((r) => [r.workflowVersionId, r._count]));

    res.json(
      versions.map((v) => ({
        id: v.id,
        version: v.version,
        publishedAt: v.publishedAt.toISOString(),
        instanceCount: countMap.get(v.id) ?? 0,
      })),
    );
  } catch (err) {
    console.error("[workflows] versions error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /creators — list all creators for enrollment UI
// ---------------------------------------------------------------------------

router.get("/", async (_req, res) => {
  // This path is unreachable because /:id catches everything.
  // Creators are listed via a separate /creators route in index.ts.
  res.json([]);
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/enroll — enroll creators into latest published version
// ---------------------------------------------------------------------------

router.post("/:id/enroll", async (req: Request, res: Response) => {
  const { creatorIds, postAcceptanceMode } = req.body as {
    creatorIds?: unknown;
    postAcceptanceMode?: unknown;
  };
  if (!Array.isArray(creatorIds) || creatorIds.length === 0) {
    res.status(400).json({ error: "creatorIds must be a non-empty array" });
    return;
  }
  const ids = creatorIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length === 0) {
    res.status(400).json({ error: "creatorIds must contain valid string ids" });
    return;
  }
  // PLU-70: an optional per-enrollment override. Reject an unrecognized value
  // rather than defaulting it — silently ignoring a typo here would enroll a
  // batch under the wrong post-acceptance behavior, and the mode is LOCKED once
  // the instance exists, so there is no cheap way back.
  if (
    postAcceptanceMode !== undefined &&
    postAcceptanceMode !== "local_payment" &&
    postAcceptanceMode !== "operator_handoff"
  ) {
    res.status(400).json({
      error: "postAcceptanceMode must be one of: local_payment, operator_handoff",
    });
    return;
  }

  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = await findLatestVersion(wf.id);
    if (!latestVersion) {
      res.status(422).json({
        error: "workflow has no published version. Publish before enrolling creators.",
      });
      return;
    }

    // Resolve the effective mode ONCE for this batch:
    //   explicit override → the campaign's default → local_payment.
    // Stamping it onto each instance is what locks it: editing the campaign
    // later, or publishing a new version, can never change how these executions
    // behave after acceptance.
    let effectiveMode: "local_payment" | "operator_handoff" = "local_payment";
    if (postAcceptanceMode === "local_payment" || postAcceptanceMode === "operator_handoff") {
      effectiveMode = postAcceptanceMode;
    } else if (wf.campaignId) {
      const campaign = await findCampaignById(wf.campaignId);
      if (campaign?.postAcceptanceMode === "operator_handoff") {
        effectiveMode = "operator_handoff";
      }
    }

    let enrolled = 0;
    let skipped = 0;

    for (const creatorId of ids) {
      try {
        await createInstance({
          creatorId,
          workflowVersionId: latestVersion.id,
          postAcceptanceMode: effectiveMode,
        });
        enrolled++;
      } catch (err) {
        // Unique violation: already enrolled in this version. FK violation:
        // the creator id doesn't exist (Prisma surfaced that as P2025 on the
        // nested connect). Both are skip-and-continue.
        if (isUniqueViolation(err) || isForeignKeyViolation(err)) {
          skipped++;
        } else {
          throw err;
        }
      }
    }

    // Echo the applied mode so the UI can state what these creators were
    // enrolled under rather than assuming the campaign default held.
    res.json({
      enrolled,
      skipped,
      versionId: latestVersion.id,
      postAcceptanceMode: effectiveMode,
    });
  } catch (err) {
    console.error("[workflows] enroll error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/launch — enqueue node-execution jobs for ENROLLED instances
// ---------------------------------------------------------------------------

router.post("/:id/launch", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = await findLatestVersion(wf.id);
    if (!latestVersion) {
      res.status(422).json({ error: "no published version to launch" });
      return;
    }

    // Launch-time validation gate (Phase 17). The published version's graph was
    // validated at publish, but we re-check here as a safety net — this also
    // protects versions published before graph validation existed. A broken
    // graph must never start executing.
    const launchValidation = validateWorkflowNodes(latestVersion.nodeGraph, {
      structuralOnly: true,
    });
    if (!launchValidation.valid) {
      res.status(422).json({
        error: "published workflow graph is invalid — cannot launch",
        validationErrors: launchValidation.errors,
        validationIssues: launchValidation.issues,
      });
      return;
    }

    const instances = await listInstancesByVersion(latestVersion.id);
    const enrolled = instances.filter((i) => i.currentState === "ENROLLED");

    for (const instance of enrolled) {
      await enqueueNodeExecution({
        instanceId: instance.id,
        expectedState: "ENROLLED",
        triggerRef: `launch-${instance.id}`,
      });
    }

    res.json({
      launched: enrolled.length,
      versionId: latestVersion.id,
      totalInstances: instances.length,
    });
  } catch (err) {
    console.error("[workflows] launch error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /workflows/:id/execution — live execution summary for this workflow
// ---------------------------------------------------------------------------

router.get("/:id/execution", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = await findLatestVersion(wf.id);
    if (!latestVersion) {
      res.json({
        versionId: null,
        version: null,
        totalInstances: 0,
        stateCounts: {},
        recentEvents: [],
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    const instances = await listInstancesByVersion(latestVersion.id);
    const stateCounts: Record<string, number> = {};
    for (const inst of instances) {
      stateCounts[inst.currentState] = (stateCounts[inst.currentState] ?? 0) + 1;
    }

    // Recent events across all instances in this version
    const recentEvents = await db
      .select({
        id: eventsTable.id,
        type: eventsTable.type,
        payload: eventsTable.payload,
        occurredAt: eventsTable.occurredAt,
        instanceId: eventsTable.instanceId,
        creatorName: creatorsTable.name,
        creatorHandle: creatorsTable.handle,
      })
      .from(eventsTable)
      .innerJoin(executionInstances, eq(eventsTable.instanceId, executionInstances.id))
      .innerJoin(creatorsTable, eq(executionInstances.creatorId, creatorsTable.id))
      .where(
        and(
          eq(executionInstances.workflowVersionId, latestVersion.id),
          eq(eventsTable.type, "STATE_TRANSITION"),
        ),
      )
      .orderBy(desc(eventsTable.occurredAt))
      .limit(20);

    res.json({
      versionId: latestVersion.id,
      version: latestVersion.version,
      totalInstances: instances.length,
      // PLU-109: lets the enroll picker show an ENROLLED badge and offer
      // "select only those not yet enrolled". The enroll endpoint already skips
      // duplicates server-side; this makes the count on the button honest
      // BEFORE the operator clicks. Free — the instances are already loaded.
      enrolledCreatorIds: instances.map((i) => i.creatorId),
      stateCounts,
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        instanceId: e.instanceId,
        creatorName: e.creatorName,
        creatorHandle: e.creatorHandle,
        payload: e.payload,
        occurredAt: e.occurredAt.toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[workflows] execution error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
