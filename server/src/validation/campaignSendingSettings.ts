export const DEFAULT_CAMPAIGN_SENDING_SETTINGS = {
  dailyInitialOutreachLimit: 30,
  outreachPacingMinMinutes: 5,
  outreachPacingMaxMinutes: 10,
  negotiationReplyPacingMinMinutes: 1,
  negotiationReplyPacingMaxMinutes: 5,
} as const;

export interface CampaignSendingSettings {
  dailyInitialOutreachLimit: number;
  outreachPacingMinMinutes: number;
  outreachPacingMaxMinutes: number;
  negotiationReplyPacingMinMinutes: number;
  negotiationReplyPacingMaxMinutes: number;
}

export type CampaignSendingSettingsPatch = Partial<CampaignSendingSettings>;

export type SendingSettingsValidation<T> =
  | { valid: true; value: T }
  | { valid: false; error: string };

const DAILY_MAX = 1_000;
const PACING_MAX_MINUTES = 60;

function validateInteger(
  value: unknown,
  label: string,
  max: number,
): SendingSettingsValidation<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    return { valid: false, error: `${label} must be an integer between 1 and ${max}` };
  }
  return { valid: true, value };
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function validateBounds(
  min: number,
  max: number,
  label: string,
): SendingSettingsValidation<true> {
  if (min > max) {
    return { valid: false, error: `${label} minimum cannot exceed maximum` };
  }
  return { valid: true, value: true };
}

/** New campaigns always persist explicit safe defaults, even for older clients. */
export function validateCreateSendingSettings(
  input: Record<string, unknown>,
): SendingSettingsValidation<CampaignSendingSettings> {
  const resolved: Record<keyof CampaignSendingSettings, unknown> = {
    dailyInitialOutreachLimit: hasOwn(input, "dailyInitialOutreachLimit")
      ? input["dailyInitialOutreachLimit"]
      : DEFAULT_CAMPAIGN_SENDING_SETTINGS.dailyInitialOutreachLimit,
    outreachPacingMinMinutes: hasOwn(input, "outreachPacingMinMinutes")
      ? input["outreachPacingMinMinutes"]
      : DEFAULT_CAMPAIGN_SENDING_SETTINGS.outreachPacingMinMinutes,
    outreachPacingMaxMinutes: hasOwn(input, "outreachPacingMaxMinutes")
      ? input["outreachPacingMaxMinutes"]
      : DEFAULT_CAMPAIGN_SENDING_SETTINGS.outreachPacingMaxMinutes,
    negotiationReplyPacingMinMinutes: hasOwn(input, "negotiationReplyPacingMinMinutes")
      ? input["negotiationReplyPacingMinMinutes"]
      : DEFAULT_CAMPAIGN_SENDING_SETTINGS.negotiationReplyPacingMinMinutes,
    negotiationReplyPacingMaxMinutes: hasOwn(input, "negotiationReplyPacingMaxMinutes")
      ? input["negotiationReplyPacingMaxMinutes"]
      : DEFAULT_CAMPAIGN_SENDING_SETTINGS.negotiationReplyPacingMaxMinutes,
  };

  return validateAll(resolved);
}

/**
 * Validate only supplied update fields. Pacing windows are updated as a pair so
 * a request cannot persist a half-configured policy; legacy all-null campaigns
 * remain untouched until an operator explicitly saves complete settings.
 */
export function validatePatchSendingSettings(
  input: Record<string, unknown>,
): SendingSettingsValidation<CampaignSendingSettingsPatch> {
  const patch: CampaignSendingSettingsPatch = {};

  if (hasOwn(input, "dailyInitialOutreachLimit")) {
    const daily = validateInteger(
      input["dailyInitialOutreachLimit"],
      "dailyInitialOutreachLimit",
      DAILY_MAX,
    );
    if (!daily.valid) return daily;
    patch.dailyInitialOutreachLimit = daily.value;
  }

  for (const [minKey, maxKey, label] of [
    ["outreachPacingMinMinutes", "outreachPacingMaxMinutes", "outreach pacing"],
    [
      "negotiationReplyPacingMinMinutes",
      "negotiationReplyPacingMaxMinutes",
      "negotiation reply pacing",
    ],
  ] as const) {
    const hasMin = hasOwn(input, minKey);
    const hasMax = hasOwn(input, maxKey);
    if (hasMin !== hasMax) {
      return { valid: false, error: `${minKey} and ${maxKey} must be supplied together` };
    }
    if (!hasMin) continue;

    const min = validateInteger(input[minKey], minKey, PACING_MAX_MINUTES);
    if (!min.valid) return min;
    const max = validateInteger(input[maxKey], maxKey, PACING_MAX_MINUTES);
    if (!max.valid) return max;
    const bounds = validateBounds(min.value, max.value, label);
    if (!bounds.valid) return bounds;
    patch[minKey] = min.value;
    patch[maxKey] = max.value;
  }

  return { valid: true, value: patch };
}

function validateAll(
  input: Record<keyof CampaignSendingSettings, unknown>,
): SendingSettingsValidation<CampaignSendingSettings> {
  const daily = validateInteger(
    input.dailyInitialOutreachLimit,
    "dailyInitialOutreachLimit",
    DAILY_MAX,
  );
  if (!daily.valid) return daily;
  const outreachMin = validateInteger(
    input.outreachPacingMinMinutes,
    "outreachPacingMinMinutes",
    PACING_MAX_MINUTES,
  );
  if (!outreachMin.valid) return outreachMin;
  const outreachMax = validateInteger(
    input.outreachPacingMaxMinutes,
    "outreachPacingMaxMinutes",
    PACING_MAX_MINUTES,
  );
  if (!outreachMax.valid) return outreachMax;
  const negotiationMin = validateInteger(
    input.negotiationReplyPacingMinMinutes,
    "negotiationReplyPacingMinMinutes",
    PACING_MAX_MINUTES,
  );
  if (!negotiationMin.valid) return negotiationMin;
  const negotiationMax = validateInteger(
    input.negotiationReplyPacingMaxMinutes,
    "negotiationReplyPacingMaxMinutes",
    PACING_MAX_MINUTES,
  );
  if (!negotiationMax.valid) return negotiationMax;

  const outreachBounds = validateBounds(outreachMin.value, outreachMax.value, "outreach pacing");
  if (!outreachBounds.valid) return outreachBounds;
  const negotiationBounds = validateBounds(
    negotiationMin.value,
    negotiationMax.value,
    "negotiation reply pacing",
  );
  if (!negotiationBounds.valid) return negotiationBounds;

  return {
    valid: true,
    value: {
      dailyInitialOutreachLimit: daily.value,
      outreachPacingMinMinutes: outreachMin.value,
      outreachPacingMaxMinutes: outreachMax.value,
      negotiationReplyPacingMinMinutes: negotiationMin.value,
      negotiationReplyPacingMaxMinutes: negotiationMax.value,
    },
  };
}
