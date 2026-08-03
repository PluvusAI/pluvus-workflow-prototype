/**
 * PLU-121 regressions: campaigns may select only active connected accounts.
 *
 * Run: npx tsx --test src/routes/campaigns.emailAccount.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { db } from "../db/drizzle.js";
import router from "./campaigns.js";

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
};

function routeHandler(path: string, method: "post" | "patch"): RequestHandler {
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method],
  );
  assert.ok(layer?.route, `${method.toUpperCase()} ${path} route must exist`);
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

test("campaign create and patch reject disabled or revoked accounts before writing", async (t) => {
  let accountStatus: "disabled" | "revoked" = "disabled";
  let insertCalls = 0;
  let updateCalls = 0;
  const mockDb = db as unknown as {
    select: (...args: unknown[]) => unknown;
    insert: (...args: unknown[]) => unknown;
    update: (...args: unknown[]) => unknown;
  };

  t.mock.method(mockDb, "select", () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: "acct-1", status: accountStatus }],
      }),
    }),
  }));
  t.mock.method(mockDb, "insert", () => {
    insertCalls++;
    throw new Error("an ineligible account must be rejected before insert");
  });
  t.mock.method(mockDb, "update", () => {
    updateCalls++;
    throw new Error("an ineligible account must be rejected before update");
  });

  const create = routeHandler("/", "post");
  const patch = routeHandler("/:id", "patch");
  const expectedBody = {
    error: "emailAccountId must reference an active connected account",
  };

  for (const status of ["disabled", "revoked"] as const) {
    accountStatus = status;

    const createResult = responseRecorder();
    await create(
      {
        body: { name: "Test campaign", brand: "Test brand", emailAccountId: "acct-1" },
        params: {},
      } as unknown as Request,
      createResult.response,
      (() => undefined) as NextFunction,
    );
    assert.equal(createResult.result.statusCode, 400, `create must reject ${status}`);
    assert.deepEqual(createResult.result.body, expectedBody);

    const patchResult = responseRecorder();
    await patch(
      {
        body: { emailAccountId: "acct-1" },
        params: { id: "campaign-1" },
      } as unknown as Request,
      patchResult.response,
      (() => undefined) as NextFunction,
    );
    assert.equal(patchResult.result.statusCode, 400, `patch must reject ${status}`);
    assert.deepEqual(patchResult.result.body, expectedBody);
  }

  assert.equal(insertCalls, 0);
  assert.equal(updateCalls, 0);
});
