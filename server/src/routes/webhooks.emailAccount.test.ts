/**
 * PLU-121 webhook regressions: grant-local correlation and durable late replies.
 *
 * Run: npx tsx --test src/routes/webhooks.emailAccount.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { computeSignature } from "../providers/nylas/verifySignature.js";
import {
  handleNylasWebhook,
  wrapNylasWebhookHandler,
  type WebhookDependencies,
} from "./webhooks.js";

const WEBHOOK_SECRET = "webhook-account-regression-secret";

type EmailAccount = NonNullable<
  Awaited<ReturnType<WebhookDependencies["findEmailAccountByGrantId"]>>
>;
type ThreadMessage = Awaited<
  ReturnType<WebhookDependencies["findMessagesByThreadId"]>
>[number];
type InboundJob = Parameters<WebhookDependencies["enqueueInboundEmail"]>[0];

function postHandler(dependencies: WebhookDependencies) {
  return (req: Request, res: Response) =>
    handleNylasWebhook(req, res, dependencies);
}

function dependencies(
  overrides: Partial<WebhookDependencies> = {},
): WebhookDependencies {
  return {
    findEmailAccountByGrantId: async () => null,
    findMessagesByThreadId: async () => [],
    enqueueInboundEmail: async () => undefined,
    ...overrides,
  };
}

function responseRecorder(): {
  response: Response;
  result: { statusCode: number; body: unknown };
} {
  const result: { statusCode: number; body: unknown } = {
    statusCode: 200,
    body: undefined,
  };
  const response = {} as Response;
  response.status = ((statusCode: number) => {
    result.statusCode = statusCode;
    return response;
  }) as Response["status"];
  response.json = ((body: unknown) => {
    result.body = body;
    return response;
  }) as Response["json"];
  return { response, result };
}

function signedRequest(args: {
  messageId: string;
  threadId: string;
  grantId?: string;
  notificationId?: string;
}): Request {
  const payload = {
    id:
      args.notificationId ??
      `notification-${args.grantId ?? "legacy"}-${args.messageId}`,
    data: {
      ...(args.grantId ? { grant_id: args.grantId } : {}),
      object: {
        id: args.messageId,
        thread_id: args.threadId,
        subject: "Re: Partnership",
        body: "I am still interested.",
        from: [{ email: "creator@example.com" }],
      },
    },
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = computeSignature(rawBody, WEBHOOK_SECRET);
  return {
    body: rawBody,
    header: (name: string) =>
      name.toLowerCase() === "x-nylas-signature" ? signature : undefined,
  } as unknown as Request;
}

function account(id: string, status: "active" | "disabled" | "revoked"): EmailAccount {
  return {
    id,
    nylasGrantId: `grant-${id}`,
    emailAddress: `${id}@example.com`,
    displayName: id,
    provider: "nylas",
    status,
    isDefault: false,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

function message(instanceId: string): ThreadMessage {
  return {
    id: `message-${instanceId}`,
    instanceId,
    emailAccountId: null,
    direction: "OUTBOUND",
    externalMessageId: `outbound-${instanceId}`,
    threadId: "shared-thread",
    senderEmail: null,
    idempotencyKey: null,
    subject: "Partnership",
    body: "Hello",
    replyIntent: null,
    classifyConfidence: null,
    redriveCount: 0,
    processedAt: null,
    sentAt: new Date("2026-08-01T00:00:00.000Z"),
    receivedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

test("a resolved grant never falls back to another account's matching thread", async (t) => {
  const previousSecret = process.env["NYLAS_WEBHOOK_SECRET"];
  process.env["NYLAS_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env["NYLAS_WEBHOOK_SECRET"];
    else process.env["NYLAS_WEBHOOK_SECRET"] = previousSecret;
  });

  const lookups: Array<[string, string | undefined]> = [];
  let enqueueCalls = 0;
  const handler = postHandler(
    dependencies({
      findEmailAccountByGrantId: async () => account("account-a", "active"),
      findMessagesByThreadId: async (threadId, emailAccountId) => {
        lookups.push([threadId, emailAccountId]);
        // Simulate the collision that caused the bug: account A has no match,
        // while an unscoped lookup would find account B's conversation.
        return emailAccountId === undefined ? [message("instance-b")] : [];
      },
      enqueueInboundEmail: async () => {
        enqueueCalls++;
      },
    }),
  );
  const { response, result } = responseRecorder();

  await handler(
    signedRequest({
      messageId: "inbound-account-a",
      threadId: "shared-thread",
      grantId: "grant-account-a",
    }),
    response,
  );

  assert.deepEqual(lookups, [["shared-thread", "account-a"]]);
  assert.equal(enqueueCalls, 0);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { status: "ignored", reason: "thread not found" });
});

test("late replies to disabled and revoked accounts are still enqueued", async (t) => {
  const previousSecret = process.env["NYLAS_WEBHOOK_SECRET"];
  process.env["NYLAS_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env["NYLAS_WEBHOOK_SECRET"];
    else process.env["NYLAS_WEBHOOK_SECRET"] = previousSecret;
  });

  for (const status of ["disabled", "revoked"] as const) {
    const enqueued: InboundJob[] = [];
    const handler = postHandler(
      dependencies({
        findEmailAccountByGrantId: async () => account(`account-${status}`, status),
        findMessagesByThreadId: async (threadId, emailAccountId) => {
          assert.equal(threadId, "shared-thread");
          assert.equal(emailAccountId, `account-${status}`);
          return [message(`instance-${status}`)];
        },
        enqueueInboundEmail: async (job) => {
          enqueued.push(job);
        },
      }),
    );
    const { response, result } = responseRecorder();

    await handler(
      signedRequest({
        messageId: `inbound-${status}`,
        threadId: "shared-thread",
        grantId: `grant-account-${status}`,
      }),
      response,
    );

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, {
      status: "accepted",
      instanceId: `instance-${status}`,
    });
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.externalMessageId, `inbound-${status}`);
    assert.equal(enqueued[0]!.instanceId, `instance-${status}`);
  }
});

test("a present but unregistered grant cannot use legacy unscoped correlation", async (t) => {
  const previousSecret = process.env["NYLAS_WEBHOOK_SECRET"];
  process.env["NYLAS_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env["NYLAS_WEBHOOK_SECRET"];
    else process.env["NYLAS_WEBHOOK_SECRET"] = previousSecret;
  });

  let messageLookups = 0;
  let enqueueCalls = 0;
  const handler = postHandler(
    dependencies({
      findEmailAccountByGrantId: async () => null,
      findMessagesByThreadId: async () => {
        messageLookups++;
        return [message("wrong-instance")];
      },
      enqueueInboundEmail: async () => {
        enqueueCalls++;
      },
    }),
  );
  const { response, result } = responseRecorder();

  await handler(
    signedRequest({
      messageId: "inbound-unknown-grant",
      threadId: "shared-thread",
      grantId: "unknown-grant",
    }),
    response,
  );

  assert.equal(messageLookups, 0);
  assert.equal(enqueueCalls, 0);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    status: "ignored",
    reason: "grant not registered",
  });
});

test("a grant-less legacy delivery retains unscoped correlation", async (t) => {
  const previousSecret = process.env["NYLAS_WEBHOOK_SECRET"];
  process.env["NYLAS_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env["NYLAS_WEBHOOK_SECRET"];
    else process.env["NYLAS_WEBHOOK_SECRET"] = previousSecret;
  });

  const lookups: Array<[string, string | undefined]> = [];
  const enqueued: InboundJob[] = [];
  const handler = postHandler(
    dependencies({
      findMessagesByThreadId: async (threadId, emailAccountId) => {
        lookups.push([threadId, emailAccountId]);
        return [message("legacy-instance")];
      },
      enqueueInboundEmail: async (job) => {
        enqueued.push(job);
      },
    }),
  );
  const { response, result } = responseRecorder();

  await handler(
    signedRequest({
      messageId: "inbound-legacy",
      threadId: "shared-thread",
    }),
    response,
  );

  assert.deepEqual(lookups, [["shared-thread", undefined]]);
  assert.equal(enqueued.length, 1);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    status: "accepted",
    instanceId: "legacy-instance",
  });
});

test("the same provider message id in two grants enqueues two account-scoped jobs", async (t) => {
  const previousSecret = process.env["NYLAS_WEBHOOK_SECRET"];
  process.env["NYLAS_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env["NYLAS_WEBHOOK_SECRET"];
    else process.env["NYLAS_WEBHOOK_SECRET"] = previousSecret;
  });

  const enqueued: InboundJob[] = [];
  const handler = postHandler(
    dependencies({
      findEmailAccountByGrantId: async (grantId) => {
        if (grantId === "grant-collision-a") return account("collision-a", "active");
        if (grantId === "grant-collision-b") return account("collision-b", "active");
        return null;
      },
      findMessagesByThreadId: async (_threadId, emailAccountId) => [
        message(`instance-${emailAccountId}`),
      ],
      enqueueInboundEmail: async (job) => {
        enqueued.push(job);
      },
    }),
  );

  for (const suffix of ["a", "b"] as const) {
    const { response, result } = responseRecorder();
    await handler(
      signedRequest({
        notificationId: `notification-collision-${suffix}`,
        messageId: "same-provider-local-id",
        threadId: "same-provider-local-thread",
        grantId: `grant-collision-${suffix}`,
      }),
      response,
    );
    assert.equal(result.statusCode, 200);
  }

  assert.equal(enqueued.length, 2);
  assert.deepEqual(
    enqueued.map((job) => [job.emailAccountId, job.externalMessageId]),
    [
      ["collision-a", "same-provider-local-id"],
      ["collision-b", "same-provider-local-id"],
    ],
  );
});

test("replay guard keys on the top-level notification id", async (t) => {
  const previousSecret = process.env["NYLAS_WEBHOOK_SECRET"];
  process.env["NYLAS_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env["NYLAS_WEBHOOK_SECRET"];
    else process.env["NYLAS_WEBHOOK_SECRET"] = previousSecret;
  });

  const enqueued: InboundJob[] = [];
  const handler = postHandler(
    dependencies({
      findEmailAccountByGrantId: async () => account("notification-account", "active"),
      findMessagesByThreadId: async () => [message("notification-instance")],
      enqueueInboundEmail: async (job) => {
        enqueued.push(job);
      },
    }),
  );

  for (const messageId of ["notification-object-a", "notification-object-b"]) {
    const { response } = responseRecorder();
    await handler(
      signedRequest({
        notificationId: "same-top-level-notification",
        messageId,
        threadId: "notification-thread",
        grantId: "grant-notification-account",
      }),
      response,
    );
  }

  assert.equal(
    enqueued.length,
    1,
    "a replay with the same notification id is dropped even if object.id differs",
  );
});

test("a transient enqueue failure does not poison the notification replay key", async (t) => {
  const previousSecret = process.env["NYLAS_WEBHOOK_SECRET"];
  process.env["NYLAS_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  t.after(() => {
    if (previousSecret === undefined) delete process.env["NYLAS_WEBHOOK_SECRET"];
    else process.env["NYLAS_WEBHOOK_SECRET"] = previousSecret;
  });

  let enqueueAttempts = 0;
  const handler = postHandler(
    dependencies({
      findEmailAccountByGrantId: async () => account("retry-account", "active"),
      findMessagesByThreadId: async () => [message("retry-instance")],
      enqueueInboundEmail: async () => {
        enqueueAttempts++;
        if (enqueueAttempts === 1) throw new Error("redis temporarily unavailable");
      },
    }),
  );
  const request = () =>
    signedRequest({
      notificationId: "retryable-notification-id",
      messageId: "retryable-message-id",
      threadId: "retryable-thread",
      grantId: "grant-retry-account",
    });

  const first = responseRecorder();
  await assert.rejects(
    () => handler(request(), first.response),
    /redis temporarily unavailable/,
  );

  const retry = responseRecorder();
  await handler(request(), retry.response);
  assert.equal(enqueueAttempts, 2, "the identical notification is retried after transient failure");
  assert.equal(retry.result.statusCode, 200);
  assert.deepEqual(retry.result.body, {
    status: "accepted",
    instanceId: "retry-instance",
  });
});

test("Express 4 wrapper forwards async webhook failures to next", async () => {
  const expected = new Error("transient dependency failure");
  let forwarded: unknown;
  const wrapped = wrapNylasWebhookHandler(async () => {
    throw expected;
  });

  wrapped(
    {} as Request,
    {} as Response,
    ((err?: unknown) => {
      forwarded = err;
    }) as never,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(forwarded, expected);
});
