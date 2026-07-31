import { useEffect, useId, useState } from "react";
import { updateCampaign } from "../../api/builderClient";
import type { WorkflowCampaign } from "../../api/builderTypes";
import { colors, font, radii } from "../../theme";
import { Button, FormField, Input, Modal, useToast } from "../ds";

interface Props {
  campaign: WorkflowCampaign;
  onSaved: () => Promise<unknown> | unknown;
}

const RECOMMENDED = {
  daily: "30",
  outreachMin: "5",
  outreachMax: "10",
  negotiationMin: "1",
  negotiationMax: "5",
};

export function CampaignSendingSettings({ campaign, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [daily, setDaily] = useState("");
  const [outreachMin, setOutreachMin] = useState("");
  const [outreachMax, setOutreachMax] = useState("");
  const [negotiationMin, setNegotiationMin] = useState("");
  const [negotiationMax, setNegotiationMax] = useState("");
  const dailyId = useId();
  const toast = useToast();

  const isLegacy = [
    campaign.dailyInitialOutreachLimit,
    campaign.outreachPacingMinMinutes,
    campaign.outreachPacingMaxMinutes,
    campaign.negotiationReplyPacingMinMinutes,
    campaign.negotiationReplyPacingMaxMinutes,
  ].some((value) => value === null);

  useEffect(() => {
    if (!open) return;
    setDaily(campaign.dailyInitialOutreachLimit?.toString() ?? "");
    setOutreachMin(campaign.outreachPacingMinMinutes?.toString() ?? "");
    setOutreachMax(campaign.outreachPacingMaxMinutes?.toString() ?? "");
    setNegotiationMin(campaign.negotiationReplyPacingMinMinutes?.toString() ?? "");
    setNegotiationMax(campaign.negotiationReplyPacingMaxMinutes?.toString() ?? "");
    setError(null);
  }, [campaign, open]);

  function useRecommended() {
    setDaily(RECOMMENDED.daily);
    setOutreachMin(RECOMMENDED.outreachMin);
    setOutreachMax(RECOMMENDED.outreachMax);
    setNegotiationMin(RECOMMENDED.negotiationMin);
    setNegotiationMax(RECOMMENDED.negotiationMax);
    setError(null);
  }

  async function save() {
    const dailyValue = Number(daily);
    const outreachMinValue = Number(outreachMin);
    const outreachMaxValue = Number(outreachMax);
    const negotiationMinValue = Number(negotiationMin);
    const negotiationMaxValue = Number(negotiationMax);
    if (
      !Number.isInteger(dailyValue) ||
      dailyValue < 1 ||
      dailyValue > 1000
    ) {
      setError("Maximum emails per day must be a whole number between 1 and 1000");
      return;
    }
    if (
      [outreachMinValue, outreachMaxValue, negotiationMinValue, negotiationMaxValue].some(
        (value) => !Number.isInteger(value) || value < 1 || value > 60,
      )
    ) {
      setError("Email pacing values must be whole minutes between 1 and 60");
      return;
    }
    if (outreachMinValue > outreachMaxValue || negotiationMinValue > negotiationMaxValue) {
      setError("The minimum email delay cannot exceed the maximum delay");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateCampaign(campaign.id, {
        dailyInitialOutreachLimit: dailyValue,
        outreachPacingMinMinutes: outreachMinValue,
        outreachPacingMaxMinutes: outreachMaxValue,
        negotiationReplyPacingMinMinutes: negotiationMinValue,
        negotiationReplyPacingMaxMinutes: negotiationMaxValue,
      });
      await onSaved();
      setOpen(false);
      toast.success("Sending settings saved.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't save sending settings";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Sending settings
      </Button>
      {open && (
        <Modal
          title="Campaign sending settings"
          subtitle={campaign.name}
          onClose={() => setOpen(false)}
          width={520}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save settings"}
              </Button>
            </>
          }
        >
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
            {isLegacy && (
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: radii.md,
                  border: `1px solid ${colors.warning}55`,
                  background: `${colors.warning}12`,
                  color: colors.textMuted,
                  fontSize: font.size.sm,
                  lineHeight: 1.5,
                }}
              >
                This campaign is using legacy sending behavior: initial outreach is unlimited and
                immediate, and negotiation replies use the service-wide delay. Saving complete
                settings enables campaign-level limits and pacing.
                <div style={{ marginTop: 10 }}>
                  <Button variant="secondary" size="sm" onClick={useRecommended}>
                    Use recommended defaults
                  </Button>
                </div>
              </div>
            )}

            <FormField
              label="Maximum emails per day"
              htmlFor={dailyId}
              hint="Initial outreach only. The counter resets at 00:00 UTC; queued recipients resume automatically."
            >
              <Input
                id={dailyId}
                type="number"
                min={1}
                max={1000}
                step={1}
                value={daily}
                onChange={(event) => setDaily(event.target.value)}
                placeholder={isLegacy ? "Unlimited (legacy)" : undefined}
              />
            </FormField>

            <PacingFields
              label="Delay between outreach emails"
              hint="Randomized spacing for initial outreach; prevents a burst when a new UTC day starts."
              min={outreachMin}
              max={outreachMax}
              onMin={setOutreachMin}
              onMax={setOutreachMax}
              legacy={isLegacy}
            />
            <PacingFields
              label="Delay between negotiation replies"
              hint="Randomized pacing for AI negotiation replies. These replies do not consume the outreach cap."
              min={negotiationMin}
              max={negotiationMax}
              onMin={setNegotiationMin}
              onMax={setNegotiationMax}
              legacy={isLegacy}
            />

            {error && (
              <div
                role="alert"
                style={{
                  color: colors.danger,
                  background: `${colors.danger}0f`,
                  border: `1px solid ${colors.danger}40`,
                  borderRadius: radii.md,
                  padding: "10px 12px",
                  fontSize: font.size.sm,
                }}
              >
                {error}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function PacingFields({
  label,
  hint,
  min,
  max,
  onMin,
  onMax,
  legacy,
}: {
  label: string;
  hint: string;
  min: string;
  max: string;
  onMin: (value: string) => void;
  onMax: (value: string) => void;
  legacy: boolean;
}) {
  return (
    <FormField label={label} hint={hint}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ color: colors.textDim, fontSize: font.size.xs }}>Minimum minutes</span>
          <Input
            aria-label={`${label} minimum minutes`}
            type="number"
            min={1}
            max={60}
            step={1}
            value={min}
            onChange={(event) => onMin(event.target.value)}
            placeholder={legacy ? "Legacy" : undefined}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ color: colors.textDim, fontSize: font.size.xs }}>Maximum minutes</span>
          <Input
            aria-label={`${label} maximum minutes`}
            type="number"
            min={1}
            max={60}
            step={1}
            value={max}
            onChange={(event) => onMax(event.target.value)}
            placeholder={legacy ? "Legacy" : undefined}
          />
        </label>
      </div>
    </FormField>
  );
}
