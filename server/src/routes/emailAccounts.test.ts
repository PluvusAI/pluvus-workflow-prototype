/**
 * PLU-121 regression: an empty account PATCH is a read-only no-op.
 *
 * Run: npx tsx --test src/routes/emailAccounts.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { db } from "../db/drizzle.js";
import router from "./emailAccounts.js";

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
};

function patchHandler(): RequestHandler {
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(
    (candidate) => candidate.route?.path === "/:id" && candidate.route.methods["patch"],
  );
  assert.ok(layer?.route, "PATCH /:id route must exist");
  return layer.route.stack[0]!.handle;
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

test("empty PATCH returns the existing account without issuing an update", async (t) => {
  const existing = {
    id: "acct-1",
    nylasGrantId: "grant-1",
    emailAddress: "sender@example.com",
    displayName: "Sender",
    provider: "nylas",
    status: "active",
    isDefault: true,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  };
  const mockDb = db as unknown as {
    select: (...args: unknown[]) => unknown;
    update: (...args: unknown[]) => unknown;
  };

  t.mock.method(mockDb, "select", () => ({
    from: () => ({
      where: () => ({
        limit: async () => [existing],
      }),
    }),
  }));
  let updateCalls = 0;
  t.mock.method(mockDb, "update", () => {
    updateCalls++;
    throw new Error("empty PATCH must not update the database");
  });

  const { response, result } = responseRecorder();
  await patchHandler()(
    { body: {}, params: { id: existing.id } } as unknown as Request,
    response,
    (() => undefined) as NextFunction,
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    id: existing.id,
    nylasGrantId: existing.nylasGrantId,
    emailAddress: existing.emailAddress,
    displayName: existing.displayName,
    provider: existing.provider,
    status: existing.status,
    isDefault: existing.isDefault,
    createdAt: existing.createdAt.toISOString(),
    updatedAt: existing.updatedAt.toISOString(),
  });
  assert.equal(updateCalls, 0);
});

test("the unconfigured migration seed cannot be activated or made default", async (t) => {
  const existing = {
    id: "seed_default_email_account",
    nylasGrantId: "UNCONFIGURED_DEFAULT_GRANT",
    emailAddress: "default@pluvus.local",
    displayName: "Default mailbox",
    provider: "nylas",
    status: "disabled",
    isDefault: false,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
  const mockDb = db as unknown as {
    select: (...args: unknown[]) => unknown;
    update: (...args: unknown[]) => unknown;
  };
  t.mock.method(mockDb, "select", () => ({
    from: () => ({ where: () => ({ limit: async () => [existing] }) }),
  }));
  let updateCalls = 0;
  t.mock.method(mockDb, "update", () => {
    updateCalls++;
    throw new Error("the sentinel must be rejected before update");
  });

  const { response, result } = responseRecorder();
  await patchHandler()(
    {
      body: { status: "active", isDefault: true },
      params: { id: existing.id },
    } as unknown as Request,
    response,
    (() => undefined) as NextFunction,
  );

  assert.equal(result.statusCode, 400);
  assert.deepEqual(result.body, {
    error: "the unconfigured migration seed cannot be activated or made default",
  });
  assert.equal(updateCalls, 0);
});

test("disabling the default account also releases the default slot", async (t) => {
  const existing = {
    id: "account-default",
    nylasGrantId: "grant-default",
    emailAddress: "default@example.com",
    displayName: "Default",
    provider: "nylas",
    status: "active",
    isDefault: true,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
  const mockDb = db as unknown as {
    select: (...args: unknown[]) => unknown;
    update: (...args: unknown[]) => unknown;
  };
  t.mock.method(mockDb, "select", () => ({
    from: () => ({ where: () => ({ limit: async () => [existing] }) }),
  }));
  let capturedPatch: Record<string, unknown> | undefined;
  t.mock.method(mockDb, "update", () => ({
    set: (patch: Record<string, unknown>) => {
      capturedPatch = patch;
      return {
        where: () => ({
          returning: async () => [{ ...existing, ...patch, updatedAt: existing.updatedAt }],
        }),
      };
    },
  }));

  const { response, result } = responseRecorder();
  await patchHandler()(
    { body: { status: "disabled" }, params: { id: existing.id } } as unknown as Request,
    response,
    (() => undefined) as NextFunction,
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(capturedPatch, { status: "disabled", isDefault: false });
});
