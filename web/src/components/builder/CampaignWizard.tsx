import { useId, useState, type ReactNode } from "react";
import { TrendingUp, Handshake, DollarSign } from "lucide-react";
import {
  createCampaign,
  createWorkflowForCampaign,
  useEmailAccounts,
} from "../../api/builderClient";
import { colors, radii, font } from "../../theme";
import { Modal, Button, Input, Textarea, Toggle, Select, FormField, useToast } from "../ds";
import type {
  PostAcceptanceMode,
  TemplateKey,
  CampaignType,
  GiftDisposition,
  PriceStrategy,
} from "../../api/builderTypes";

interface Props {
  onCreated: (workflowId: string) => void;
  onClose: () => void;
}

const TEMPLATES: { key: TemplateKey; name: string; description: string; icon: ReactNode }[] = [
  {
    key: "affiliate",
    name: "Affiliate Campaign",
    description:
      "Performance-based. Creators earn commission on conversions. Zero upfront cost to the brand.",
    icon: <TrendingUp size={18} strokeWidth={1.75} />,
  },
  {
    key: "hybrid",
    name: "Hybrid Campaign",
    description:
      "Base fee + affiliate commission. Best for mid-tier creators who want guaranteed payment.",
    icon: <Handshake size={18} strokeWidth={1.75} />,
  },
  {
    key: "fixed_fee",
    name: "Fixed Fee Campaign",
    description:
      "Flat payment for deliverables. Simple, predictable, no performance tracking needed.",
    icon: <DollarSign size={18} strokeWidth={1.75} />,
  },
];

export function CampaignWizard({ onCreated, onClose }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // Step 1 fields
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [brandDescription, setBrandDescription] = useState("");
  const [deliverables, setDeliverables] = useState("");
  const [timeline, setTimeline] = useState("");
  const [rewardDescription, setRewardDescription] = useState("");
  const [shipsPhysicalProduct, setShipsPhysicalProduct] = useState(false);
  // PLU-136: compensation data contract fields.
  const [campaignType, setCampaignType] = useState<CampaignType>("PAID");
  const [priceStrategy, setPriceStrategy] = useState<PriceStrategy>("REQUEST_RATE_CARD");
  const [publicStartingFeeCents, setPublicStartingFeeCents] = useState("");
  const [publicCommissionRate, setPublicCommissionRate] = useState("");
  const [commissionDurationDays, setCommissionDurationDays] = useState("");
  const [commissionConditions, setCommissionConditions] = useState("");
  const [includesGifting, setIncludesGifting] = useState(false);
  const [giftDisposition, setGiftDisposition] = useState<GiftDisposition | "">("");
  const [objective, setObjective] = useState("");
  const [notes, setNotes] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [hiddenParamKey, setHiddenParamKey] = useState("_from");
  // PLU-70. Defaults to the existing behavior — a brand that ignores this field
  // gets exactly the campaign they would have got before.
  const [postAcceptanceMode, setPostAcceptanceMode] =
    useState<PostAcceptanceMode>("local_payment");
  const [dailyInitialOutreachLimit, setDailyInitialOutreachLimit] = useState("30");
  const [outreachPacingMinMinutes, setOutreachPacingMinMinutes] = useState("5");
  const [outreachPacingMaxMinutes, setOutreachPacingMaxMinutes] = useState("10");
  const [negotiationReplyPacingMinMinutes, setNegotiationReplyPacingMinMinutes] =
    useState("1");
  const [negotiationReplyPacingMaxMinutes, setNegotiationReplyPacingMaxMinutes] =
    useState("5");

  // PLU-121: which connected mailbox this campaign's outreach is sent from. Empty
  // string = "use the default account", so a brand that ignores this field gets
  // the default sender exactly as before multi-mailbox.
  const [emailAccountId, setEmailAccountId] = useState("");
  const { data: emailAccounts } = useEmailAccounts();
  const activeAccounts = (emailAccounts ?? []).filter((a) => a.status === "active");

  // Step 2 selection
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateKey | null>(null);
  const [workflowName, setWorkflowName] = useState("");

  // PLU-136: derived compensation-shape flags — drive which fields show and
  // what's required, mirroring validateCompensationReadiness() server-side.
  const needsFee = campaignType === "PAID" || campaignType === "HYBRID";
  const needsCommission = campaignType === "AFFILIATE" || campaignType === "HYBRID";
  const isGiftOnly = campaignType === "GIFT_ONLY";
  // GIFT_ONLY never shows a disposition picker — it's locked to KEEP (the
  // product IS the entire payment, so loan/return would mean no payment at
  // all). The picker only applies when gifting is a BONUS on top of a real
  // fee/commission.
  const showsGiftDispositionPicker = includesGifting && !isGiftOnly;
  const needsGiftDetails = isGiftOnly || includesGifting;

  const nameId = useId();
  const brandId = useId();
  const notifyId = useId();
  const brandDescId = useId();
  const deliverablesId = useId();
  const timelineId = useId();
  const rewardId = useId();
  const objId = useId();
  const notesId = useId();
  const wfNameId = useId();
  const targetUrlId = useId();
  const hiddenParamKeyId = useId();
  const postAcceptId = useId();
  const dailyLimitId = useId();
  const outreachMinId = useId();
  const outreachMaxId = useId();
  const negotiationMinId = useId();
  const negotiationMaxId = useId();
  const senderId = useId();
  const campaignTypeId = useId();
  const priceStrategyId = useId();
  const startingFeeId = useId();
  const commissionRateId = useId();
  const commissionDurationId = useId();
  const commissionConditionsId = useId();
  const giftDispositionId = useId();

  const notifyEmailInvalid =
    !!notifyEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail.trim());

  const targetUrlInvalid = !!targetUrl.trim() && (() => {
    try { new URL(targetUrl.trim()); return false; } catch { return true; }
  })();

  function handleStep1Next() {
    if (!name.trim()) {
      setError("Campaign name is required");
      return;
    }
    if (!brand.trim()) {
      setError("Brand is required");
      return;
    }
    if (notifyEmailInvalid) {
      setError("Notification email must be a valid email address");
      return;
    }
    if (targetUrlInvalid) {
      setError("Product URL must be a valid URL (e.g. https://example.com/shop)");
      return;
    }
    const daily = Number(dailyInitialOutreachLimit);
    const outreachMin = Number(outreachPacingMinMinutes);
    const outreachMax = Number(outreachPacingMaxMinutes);
    const negotiationMin = Number(negotiationReplyPacingMinMinutes);
    const negotiationMax = Number(negotiationReplyPacingMaxMinutes);
    if (!Number.isInteger(daily) || daily < 1 || daily > 1000) {
      setError("Maximum emails per day must be a whole number between 1 and 1000");
      return;
    }
    if (
      [outreachMin, outreachMax, negotiationMin, negotiationMax].some(
        (value) => !Number.isInteger(value) || value < 1 || value > 60,
      )
    ) {
      setError("Email pacing values must be whole minutes between 1 and 60");
      return;
    }
    if (outreachMin > outreachMax || negotiationMin > negotiationMax) {
      setError("The minimum email delay cannot exceed the maximum delay");
      return;
    }
    // PLU-136: compensation fields — mirrors validateCompensationReadiness()
    // server-side (minus the NegotiationPolicy-authority checks, which this
    // wizard doesn't collect; a campaign still needs a negotiation policy
    // set separately before it can launch).
    if (needsFee && priceStrategy === "PROPOSE_STARTING_FEE") {
      const fee = Number(publicStartingFeeCents);
      if (!publicStartingFeeCents.trim() || !Number.isFinite(fee) || fee <= 0) {
        setError("Enter a starting fee amount, or switch to requesting the creator's rate card");
        return;
      }
    }
    if (needsCommission) {
      const rate = Number(publicCommissionRate);
      if (!publicCommissionRate.trim() || !Number.isFinite(rate) || rate <= 0 || rate > 100) {
        setError("Enter a commission rate between 0 and 100");
        return;
      }
    }
    if (needsGiftDetails) {
      if (!rewardDescription.trim()) {
        setError("Describe the product being offered, in Product / Sample Reward above");
        return;
      }
      if (showsGiftDispositionPicker && !giftDisposition) {
        setError("Choose what happens to the product after the campaign");
        return;
      }
    }
    setError(null);
    setWorkflowName(`${name.trim()} Outreach`);
    setStep(2);
  }

  async function handleCreate() {
    if (!selectedTemplate) {
      setError("Please select a template");
      return;
    }
    if (!workflowName.trim()) {
      setError("Workflow name is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Identical payload shape to the original implementation.
      const campaignData: Parameters<typeof createCampaign>[0] = {
        name: name.trim(),
        brand: brand.trim(),
        dailyInitialOutreachLimit: Number(dailyInitialOutreachLimit),
        outreachPacingMinMinutes: Number(outreachPacingMinMinutes),
        outreachPacingMaxMinutes: Number(outreachPacingMaxMinutes),
        negotiationReplyPacingMinMinutes: Number(negotiationReplyPacingMinMinutes),
        negotiationReplyPacingMaxMinutes: Number(negotiationReplyPacingMaxMinutes),
      };
      if (notifyEmail.trim()) campaignData.notifyEmail = notifyEmail.trim();
      if (brandDescription.trim()) campaignData.brandDescription = brandDescription.trim();
      if (deliverables.trim()) campaignData.deliverables = deliverables.trim();
      if (timeline.trim()) campaignData.timeline = timeline.trim();
      if (rewardDescription.trim()) campaignData.rewardDescription = rewardDescription.trim();
      if (shipsPhysicalProduct) campaignData.shipsPhysicalProduct = true;
      if (objective.trim()) campaignData.objective = objective.trim();
      if (notes.trim()) campaignData.notes = notes.trim();
      if (targetUrl.trim()) campaignData.targetUrl = targetUrl.trim();
      if (hiddenParamKey.trim() && hiddenParamKey.trim() !== "_from")
        campaignData.hiddenParamKey = hiddenParamKey.trim();
      // Sent only when it differs from the default, so the request body for an
      // ordinary campaign is unchanged.
      if (postAcceptanceMode !== "local_payment")
        campaignData.postAcceptanceMode = postAcceptanceMode;
      // PLU-121: send only when a specific mailbox was chosen; empty → the server
      // leaves it null and enrollment falls back to the default account.
      if (emailAccountId) campaignData.emailAccountId = emailAccountId;
      // PLU-136: compensation data contract fields.
      campaignData.campaignType = campaignType;
      if (needsFee) {
        campaignData.priceStrategy = priceStrategy;
        if (priceStrategy === "PROPOSE_STARTING_FEE" && publicStartingFeeCents.trim()) {
          campaignData.publicStartingFeeCents = Math.round(Number(publicStartingFeeCents) * 100);
        }
      }
      if (needsCommission && publicCommissionRate.trim()) {
        campaignData.publicCommissionRate = Number(publicCommissionRate);
        if (commissionDurationDays.trim())
          campaignData.commissionDurationDays = Number(commissionDurationDays);
        if (commissionConditions.trim())
          campaignData.commissionConditions = commissionConditions.trim();
      }
      if (isGiftOnly) {
        campaignData.includesGifting = true;
        campaignData.giftDisposition = "KEEP";
      } else if (includesGifting) {
        campaignData.includesGifting = true;
        if (giftDisposition) campaignData.giftDisposition = giftDisposition;
      }
      // This wizard is the explicit-selection UI PLU-136 needed — a genuine,
      // verified brand choice, not an unverified backfill default.
      campaignData.compensationReviewStatus = "CONFIRMED";
      const campaign = await createCampaign(campaignData);
      const workflow = await createWorkflowForCampaign(campaign.id, {
        name: workflowName.trim(),
        templateKey: selectedTemplate,
      });
      toast.success(`Created “${campaign.name}”.`);
      onCreated(workflow.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={step === 1 ? "Create Campaign" : "Choose Template"}
      subtitle={`Step ${step} of 2`}
      onClose={onClose}
      width={560}
      footer={
        <>
          {step === 2 ? (
            <Button variant="secondary" onClick={() => setStep(1)} disabled={submitting} leftIcon="←">
              Back
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          )}
          {step === 1 ? (
            <Button variant="primary" onClick={handleStep1Next} rightIcon="→">
              Next
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void handleCreate()}
              disabled={submitting || !selectedTemplate}
            >
              {submitting ? "Creating…" : "Create Workflow"}
            </Button>
          )}
        </>
      }
    >
      {/* Step progress bar */}
      <div style={{ padding: "16px 24px 0", display: "flex", gap: 8 }}>
        {[1, 2].map((s) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: s <= step ? colors.accent : colors.panelAlt,
              transition: "background 0.25s ease",
            }}
          />
        ))}
      </div>

      <div style={{ padding: "20px 24px 24px" }}>
        {step === 1 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <FormField label="Campaign Name *" htmlFor={nameId}>
              <Input
                id={nameId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Summer 2026 Launch"
                invalid={!!error && !name.trim()}
                autoFocus
              />
            </FormField>
            <FormField label="Brand *" htmlFor={brandId}>
              <Input
                id={brandId}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="e.g. Acme Co"
                invalid={!!error && !brand.trim()}
              />
            </FormField>
            <FormField
              label="Brand Description"
              htmlFor={brandDescId}
              hint="What the brand does or sells. The AI uses this to answer creator questions like 'what does your brand do?' without making things up."
            >
              <Textarea
                id={brandDescId}
                value={brandDescription}
                onChange={(e) => setBrandDescription(e.target.value)}
                placeholder="e.g. Avatar is a fintech app that helps Gen Z track spending and build credit through a prepaid card."
                rows={3}
              />
            </FormField>
            <FormField
              label="Deliverables"
              htmlFor={deliverablesId}
              hint="What the creator is expected to produce. The AI states this as the agreed scope in outreach and negotiation. Leave blank to finalize it later with the creator."
            >
              <Textarea
                id={deliverablesId}
                value={deliverables}
                onChange={(e) => setDeliverables(e.target.value)}
                placeholder="e.g. 3 Instagram Reels + 1 YouTube integration, with 30-day usage rights."
                rows={2}
              />
            </FormField>
            <FormField
              label="Timeline"
              htmlFor={timelineId}
              hint="When the content should go live. The AI only states a timeline when you provide one here — it never invents dates."
            >
              <Input
                id={timelineId}
                value={timeline}
                onChange={(e) => setTimeline(e.target.value)}
                placeholder="e.g. Content live by September 15, 2026"
              />
            </FormField>
            <FormField
              label="Compensation structure *"
              htmlFor={campaignTypeId}
              hint={
                campaignType === "PAID"
                  ? "The creator gets an upfront fee, no commission."
                  : campaignType === "AFFILIATE"
                    ? "The creator earns commission on conversions, no upfront fee."
                    : campaignType === "HYBRID"
                      ? "The creator gets an upfront fee plus commission on conversions."
                      : "The product/gift IS the entire payment — no cash fee or commission."
              }
            >
              <Select
                id={campaignTypeId}
                value={campaignType}
                onChange={(e) => setCampaignType(e.target.value as CampaignType)}
              >
                <option value="PAID">Paid — upfront fee</option>
                <option value="AFFILIATE">Affiliate — commission only</option>
                <option value="HYBRID">Hybrid — fee + commission</option>
                <option value="GIFT_ONLY">Gift only — product is the payment</option>
              </Select>
            </FormField>
            {needsFee && (
              <FormField
                label="Price strategy"
                htmlFor={priceStrategyId}
                hint={
                  priceStrategy === "PROPOSE_STARTING_FEE"
                    ? "You propose a starting number; the creator can still negotiate it."
                    : "The creator shares their own rate card first — no number is proposed here."
                }
              >
                <Select
                  id={priceStrategyId}
                  value={priceStrategy}
                  onChange={(e) => setPriceStrategy(e.target.value as PriceStrategy)}
                >
                  <option value="REQUEST_RATE_CARD">Request the creator's rate card</option>
                  <option value="PROPOSE_STARTING_FEE">Propose a starting fee</option>
                </Select>
              </FormField>
            )}
            {needsFee && priceStrategy === "PROPOSE_STARTING_FEE" && (
              <FormField
                label="Starting fee offer ($)"
                htmlFor={startingFeeId}
                hint="The public starting number shown to the creator — still negotiable unless you mark it fixed in the negotiation policy."
              >
                <Input
                  id={startingFeeId}
                  type="number"
                  min={0}
                  step="1"
                  value={publicStartingFeeCents}
                  onChange={(e) => setPublicStartingFeeCents(e.target.value)}
                  placeholder="e.g. 500"
                />
              </FormField>
            )}
            {needsCommission && (
              <>
                <FormField
                  label="Commission rate (%)"
                  htmlFor={commissionRateId}
                  hint="The public commission rate shown to the creator."
                >
                  <Input
                    id={commissionRateId}
                    type="number"
                    min={0}
                    max={100}
                    step="0.1"
                    value={publicCommissionRate}
                    onChange={(e) => setPublicCommissionRate(e.target.value)}
                    placeholder="e.g. 15"
                  />
                </FormField>
                <FormField
                  label="Commission duration (days)"
                  htmlFor={commissionDurationId}
                  hint="How long the commission window runs. Leave blank if not applicable."
                >
                  <Input
                    id={commissionDurationId}
                    type="number"
                    min={1}
                    step="1"
                    value={commissionDurationDays}
                    onChange={(e) => setCommissionDurationDays(e.target.value)}
                    placeholder="e.g. 30"
                  />
                </FormField>
                <FormField label="Commission conditions" htmlFor={commissionConditionsId}>
                  <Textarea
                    id={commissionConditionsId}
                    value={commissionConditions}
                    onChange={(e) => setCommissionConditions(e.target.value)}
                    placeholder="e.g. applies to first-time customers only"
                    rows={2}
                  />
                </FormField>
              </>
            )}
            <FormField
              label={isGiftOnly ? "Product / Gift *" : "Product / Sample Reward"}
              htmlFor={rewardId}
              hint={
                isGiftOnly
                  ? "Describe the product the creator receives — this is their entire payment, so it's kept, not returned."
                  : "Describe any product or free sample the creator receives. The AI mentions this across the outreach and negotiation emails. Leave blank for cash-only deals."
              }
            >
              <Textarea
                id={rewardId}
                value={rewardDescription}
                onChange={(e) => setRewardDescription(e.target.value)}
                placeholder="e.g. a free pair of our latest running shoes (retail $140)"
                rows={2}
              />
            </FormField>
            <FormField
              label="Ships a physical product"
              hint="When on, the payment form also asks the creator for a shipping address so we can send the product. Independent of gifting below — a content-creation sample the creator ships back isn't compensation."
            >
              <Toggle
                checked={shipsPhysicalProduct}
                onChange={setShipsPhysicalProduct}
                label="Collect a shipping address on the payment form"
              />
            </FormField>
            {!isGiftOnly && (
              <FormField
                label="Includes a gifted product"
                hint="When on, the product above is part of the creator's compensation — on top of the fee/commission — not just a sample for content."
              >
                <Toggle
                  checked={includesGifting}
                  onChange={setIncludesGifting}
                  label="This campaign includes a gift as compensation"
                />
              </FormField>
            )}
            {showsGiftDispositionPicker && (
              <FormField label="What happens to the product?" htmlFor={giftDispositionId}>
                <Select
                  id={giftDispositionId}
                  value={giftDisposition}
                  onChange={(e) => setGiftDisposition(e.target.value as GiftDisposition)}
                >
                  <option value="">Choose one…</option>
                  <option value="KEEP">Creator keeps it</option>
                  <option value="LOAN">Loaned — creator uses it, then returns it</option>
                  <option value="RETURN">Must be returned after the campaign</option>
                </Select>
              </FormField>
            )}
            <FormField
              label="Escalation notification email"
              htmlFor={notifyId}
              hint="Where we email the brand when a creator is escalated to the manual review queue. Defaults to the workspace operator if left blank."
            >
              <Input
                id={notifyId}
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="e.g. partnerships@acme.com"
                invalid={notifyEmailInvalid}
              />
            </FormField>
            <FormField
              label="Send outreach from"
              htmlFor={senderId}
              hint={
                activeAccounts.length === 0
                  ? "No active mailbox is registered yet. An operator must register one through the email-accounts API before a Nylas campaign can enroll creators."
                  : "The connected mailbox this campaign's outreach, follow-ups, and replies are sent from. The whole conversation stays on this mailbox."
              }
            >
              <Select
                id={senderId}
                value={emailAccountId}
                onChange={(e) => setEmailAccountId(e.target.value)}
                disabled={activeAccounts.length === 0}
              >
                <option value="">Default account</option>
                {activeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ? `${a.displayName} — ${a.emailAddress}` : a.emailAddress}
                    {a.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="After a creator accepts"
              htmlFor={postAcceptId}
              hint={
                postAcceptanceMode === "operator_handoff"
                  ? "The AI runs outreach and negotiation, then pauses. You get an email with the agreed terms, the creator appears in the Manual Queue, and you finalize the deal and onboard them in Pluvus yourself."
                  : "The AI runs the whole flow: once the creator accepts it collects their payout details and sends the campaign brief automatically."
              }
            >
              <Select
                id={postAcceptId}
                value={postAcceptanceMode}
                onChange={(e) =>
                  setPostAcceptanceMode(e.target.value as "local_payment" | "operator_handoff")
                }
              >
                <option value="local_payment">Continue with local payment flow</option>
                <option value="operator_handoff">Send to operator for onboarding</option>
              </Select>
            </FormField>
            <div
              style={{
                paddingTop: 4,
                borderTop: `1px solid ${colors.border}`,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div>
                <div style={{ color: colors.text, fontWeight: font.weight.semibold }}>
                  Sending settings
                </div>
                <div style={{ color: colors.textMuted, fontSize: font.size.sm, marginTop: 3 }}>
                  Daily limits reset at 00:00 UTC. Queued outreach resumes at the normal pace.
                </div>
              </div>
              <FormField
                label="Maximum emails per day"
                htmlFor={dailyLimitId}
                hint="Applies to initial outreach only. Replies and scheduled follow-ups remain timely."
              >
                <Input
                  id={dailyLimitId}
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={dailyInitialOutreachLimit}
                  onChange={(e) => setDailyInitialOutreachLimit(e.target.value)}
                />
              </FormField>
              <FormField
                label="Delay between outreach emails"
                hint="A random delay in this range is applied after every initial outreach."
              >
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Input
                    id={outreachMinId}
                    aria-label="Minimum outreach delay in minutes"
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    value={outreachPacingMinMinutes}
                    onChange={(e) => setOutreachPacingMinMinutes(e.target.value)}
                    placeholder="Min minutes"
                  />
                  <Input
                    id={outreachMaxId}
                    aria-label="Maximum outreach delay in minutes"
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    value={outreachPacingMaxMinutes}
                    onChange={(e) => setOutreachPacingMaxMinutes(e.target.value)}
                    placeholder="Max minutes"
                  />
                </div>
              </FormField>
              <FormField
                label="Delay between negotiation replies"
                hint="Randomized reply pacing keeps automated responses from arriving instantly."
              >
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Input
                    id={negotiationMinId}
                    aria-label="Minimum negotiation reply delay in minutes"
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    value={negotiationReplyPacingMinMinutes}
                    onChange={(e) => setNegotiationReplyPacingMinMinutes(e.target.value)}
                    placeholder="Min minutes"
                  />
                  <Input
                    id={negotiationMaxId}
                    aria-label="Maximum negotiation reply delay in minutes"
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    value={negotiationReplyPacingMaxMinutes}
                    onChange={(e) => setNegotiationReplyPacingMaxMinutes(e.target.value)}
                    placeholder="Max minutes"
                  />
                </div>
              </FormField>
            </div>
            <FormField label="Objective" htmlFor={objId}>
              <Input
                id={objId}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="e.g. Drive awareness for new product launch"
              />
            </FormField>
            <FormField label="Notes" htmlFor={notesId}>
              <Textarea
                id={notesId}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any context or constraints for this campaign…"
                rows={3}
              />
            </FormField>
            <FormField
              label="Product URL"
              htmlFor={targetUrlId}
              hint="The landing page creators link to. When set, each creator gets a unique tracked referral link with the tracking parameter appended. Leave empty for flat-fee collaborations without link tracking."
            >
              <Input
                id={targetUrlId}
                type="url"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="e.g. https://example.com/shop"
                invalid={targetUrlInvalid}
              />
            </FormField>
            {targetUrl.trim() && (
              <FormField
                label="Tracking parameter"
                htmlFor={hiddenParamKeyId}
                hint="The query-string key appended to each creator's link (e.g. ?_from=casey_a1b2c3). Advanced — leave as the default unless your analytics tool expects a specific key."
              >
                <Input
                  id={hiddenParamKeyId}
                  value={hiddenParamKey}
                  onChange={(e) => setHiddenParamKey(e.target.value)}
                  placeholder="_from"
                />
              </FormField>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <FormField label="Workflow Name" htmlFor={wfNameId}>
              <Input id={wfNameId} value={workflowName} onChange={(e) => setWorkflowName(e.target.value)} />
            </FormField>
            <div style={{ fontSize: font.size.md, color: colors.textMuted }}>
              Select a template — this determines the default node pipeline:
            </div>
            <div role="radiogroup" aria-label="Workflow template" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {TEMPLATES.map((t) => (
                <TemplateCard
                  key={t.key}
                  template={t}
                  selected={selectedTemplate === t.key}
                  onSelect={() => setSelectedTemplate(t.key)}
                />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="ds-fade-in"
            style={{
              marginTop: 16,
              padding: "11px 14px",
              background: `${colors.danger}0f`,
              border: `1px solid ${colors.danger}40`,
              borderRadius: radii.md,
              fontSize: font.size.md,
              color: colors.danger,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: { key: string; name: string; description: string; icon: ReactNode };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="ds-focusable ds-card-interactive"
      style={{
        padding: "15px 17px",
        background: selected ? `${colors.accent}0f` : colors.bg,
        border: `1px solid ${selected ? colors.accent : colors.border}`,
        borderRadius: radii.md,
        boxShadow: selected ? `0 0 0 3px ${colors.accent}22` : "none",
        cursor: "pointer",
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
        textAlign: "left",
        width: "100%",
      }}
    >
      <div
        aria-hidden
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          background: colors.panelAlt,
          border: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        {template.icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.text, marginBottom: 4 }}>
          {template.name}
        </div>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, lineHeight: 1.55 }}>
          {template.description}
        </div>
      </div>
      {selected && (
        <div
          aria-hidden
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: colors.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: "#fff",
            fontSize: 12,
          }}
        >
          ✓
        </div>
      )}
    </button>
  );
}
