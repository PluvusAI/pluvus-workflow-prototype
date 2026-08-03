/** Account-aware BullMQ idempotency keys for inbound provider messages. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { inboundEmailJobId } from "./queues.js";

test("same provider message id in different accounts produces distinct jobs", () => {
  const fromA = inboundEmailJobId({
    emailAccountId: "account-a",
    externalMessageId: "provider-message-42",
  });
  const fromB = inboundEmailJobId({
    emailAccountId: "account-b",
    externalMessageId: "provider-message-42",
  });

  assert.notEqual(fromA, fromB);
  assert.equal(
    fromA,
    inboundEmailJobId({
      emailAccountId: "account-a",
      externalMessageId: "provider-message-42",
    }),
    "a redelivery in one account keeps the same job id",
  );
});

test("account-scoped job tuple encoding cannot collide on separator characters", () => {
  const first = inboundEmailJobId({
    emailAccountId: "account|message|x",
    externalMessageId: "y",
  });
  const second = inboundEmailJobId({
    emailAccountId: "account",
    externalMessageId: "x|message|y",
  });
  assert.notEqual(first, second);
});

test("account-less legacy jobs retain their original job-id shape", () => {
  assert.equal(
    inboundEmailJobId({ externalMessageId: "legacy-message" }),
    "inbound|legacy-message",
  );
});
