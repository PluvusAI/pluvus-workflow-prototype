import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CAMPAIGN_SENDING_SETTINGS,
  validateCreateSendingSettings,
  validatePatchSendingSettings,
} from "./campaignSendingSettings.js";

test("new campaigns persist recommended sending defaults", () => {
  const result = validateCreateSendingSettings({});
  assert.equal(result.valid, true);
  if (result.valid) assert.deepEqual(result.value, DEFAULT_CAMPAIGN_SENDING_SETTINGS);
});

test("daily cap rejects zero, negatives, fractions, strings, and unreasonable values", () => {
  for (const value of [0, -1, 1.5, "30", Number.NaN, 1001]) {
    assert.equal(
      validateCreateSendingSettings({ dailyInitialOutreachLimit: value }).valid,
      false,
      `expected ${String(value)} to be rejected`,
    );
  }
  assert.equal(validateCreateSendingSettings({ dailyInitialOutreachLimit: 1 }).valid, true);
  assert.equal(validateCreateSendingSettings({ dailyInitialOutreachLimit: 1000 }).valid, true);
});

test("pacing rejects invalid minutes and inverted windows", () => {
  assert.equal(
    validateCreateSendingSettings({
      outreachPacingMinMinutes: 11,
      outreachPacingMaxMinutes: 10,
    }).valid,
    false,
  );
  assert.equal(
    validateCreateSendingSettings({ negotiationReplyPacingMinMinutes: 0 }).valid,
    false,
  );
  assert.equal(
    validateCreateSendingSettings({ negotiationReplyPacingMaxMinutes: 61 }).valid,
    false,
  );
});

test("patch keeps legacy nulls untouched unless complete settings are supplied", () => {
  const empty = validatePatchSendingSettings({});
  assert.deepEqual(empty, { valid: true, value: {} });
  assert.equal(
    validatePatchSendingSettings({ outreachPacingMinMinutes: 5 }).valid,
    false,
  );
  const complete = validatePatchSendingSettings({
    dailyInitialOutreachLimit: 30,
    outreachPacingMinMinutes: 5,
    outreachPacingMaxMinutes: 10,
    negotiationReplyPacingMinMinutes: 1,
    negotiationReplyPacingMaxMinutes: 5,
  });
  assert.equal(complete.valid, true);
});
