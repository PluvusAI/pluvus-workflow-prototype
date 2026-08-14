// ---------------------------------------------------------------------------
// PLU-139 (2a) — "New Campaign" start step
// ---------------------------------------------------------------------------
// Replaces the old CampaignWizard's create flow with the minimum needed to mint
// a DRAFT campaign + its outreach workflow, then hand off to the sectioned
// intake (CampaignIntake) where the rest of the brief is filled in. It collects
// only what create genuinely needs up front: name, brand, reward structure, and
// the workflow template. Everything else is a section in the intake.
//
// The workflow-creation chain (createCampaign → createWorkflowForCampaign) is
// preserved verbatim from the old wizard so existing behavior is unchanged.
//
// COPY: strings here are PLACEHOLDER pending PLU-159, marked `// COPY:PLU-159`.

import { useId, useState } from "react";
import { createCampaign, createWorkflowForCampaign } from "../../../api/builderClient";
import type { CampaignType, TemplateKey } from "../../../api/builderTypes";
import { colors, radii, font } from "../../../theme";
import { Modal, Button, Input, FormField, RadioCardGroup, useToast } from "../../ds";
import { CAMPAIGN_TYPE_OPTIONS } from "./sections";

// Reward structure → the workflow template the campaign starts from. Mirrors the
// old wizard's three templates; gift-only has no commission/fee pipeline so it
// reuses the fixed-fee shape (the brief's reward section still records GIFT_ONLY).
const TEMPLATE_FOR_TYPE: Record<CampaignType, TemplateKey> = {
  PAID: "fixed_fee",
  AFFILIATE: "affiliate",
  HYBRID: "hybrid",
  GIFT_ONLY: "fixed_fee",
};

interface Props {
  onClose: () => void;
  /** Route to the new campaign's sectioned intake. */
  onCreated: (campaignId: string) => void;
}

export function StartCampaignModal({ onClose, onCreated }: Props) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [campaignType, setCampaignType] = useState<CampaignType>("PAID");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameId = useId();
  const brandId = useId();

  async function handleCreate() {
    if (!name.trim()) {
      setError("Campaign name is required"); // COPY:PLU-159
      return;
    }
    if (!brand.trim()) {
      setError("Brand is required"); // COPY:PLU-159
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const campaign = await createCampaign({
        name: name.trim(),
        brand: brand.trim(),
        campaignType,
        // GIFT_ONLY is all-gift and locked to KEEP; the intake's reward section
        // fills in the product details.
        ...(campaignType === "GIFT_ONLY"
          ? { includesGifting: true, giftDisposition: "KEEP" as const }
          : {}),
        // Created through an explicit-selection UI → a real brand choice.
        compensationReviewStatus: "CONFIRMED",
      });
      // Preserve the old wizard's chain: every campaign gets a starter workflow.
      await createWorkflowForCampaign(campaign.id, {
        name: `${name.trim()} Outreach`, // COPY:PLU-159
        templateKey: TEMPLATE_FOR_TYPE[campaignType],
      });
      toast.success(`Created “${campaign.name}”.`); // COPY:PLU-159
      onCreated(campaign.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      toast.error(msg);
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="New campaign" // COPY:PLU-159
      subtitle="Start the brief — you'll fill in the rest next." // COPY:PLU-159
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleCreate()} disabled={submitting} rightIcon="→">
            {submitting ? "Creating…" : "Create & continue"} {/* COPY:PLU-159 */}
          </Button>
        </>
      }
    >
      <div style={{ padding: "20px 24px 24px", display: "flex", flexDirection: "column", gap: 18 }}>
        <FormField label="Campaign name *" htmlFor={nameId}>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Summer 2026 Launch" // COPY:PLU-159
            invalid={!!error && !name.trim()}
            autoFocus
          />
        </FormField>
        <FormField label="Brand *" htmlFor={brandId}>
          <Input
            id={brandId}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="e.g. Acme Co" // COPY:PLU-159
            invalid={!!error && !brand.trim()}
          />
        </FormField>
        <FormField
          label="How will creators be rewarded?" // COPY:PLU-159
          hint="You can change this and set the amounts in the reward section next." // COPY:PLU-159
        >
          <RadioCardGroup
            ariaLabel="Reward structure"
            options={CAMPAIGN_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={campaignType}
            onChange={(v) => setCampaignType(v as CampaignType)}
          />
        </FormField>

        {error && (
          <div
            role="alert"
            className="ds-fade-in"
            style={{
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
