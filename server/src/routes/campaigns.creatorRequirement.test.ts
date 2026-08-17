/**
 * PLU-139 (2a) — route-level validation for PATCH /:id/creator-requirement.
 * Greptile P1: minFollowers of 2147483648 passed the JS-integer check but
 * overflows the PostgreSQL int4 column (SQLSTATE 22003) → catch-all 500 instead
 * of a 400. The handler must reject > int4-max at the trust boundary, BEFORE any
 * DB call (so no campaign lookup / upsert runs).
 *
 * Run: npx tsx --test src/routes/campaigns.creatorRequirement.test.ts
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

function routeHandler(path: string, method: "patch"): RequestHandler {
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
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
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

test("minFollowers above int4 max is rejected with 400 before any DB call", async (t) => {
  // Any DB touch would mean the overflow guard failed to short-circuit.
  const mockDb = db as unknown as { select: (...a: unknown[]) => unknown };
  t.mock.method(mockDb, "select", () => {
    throw new Error("validation must reject before touching the database");
  });

  const patch = routeHandler("/:id/creator-requirement", "patch");

  const overflow = responseRecorder();
  await patch(
    { body: { minFollowers: 2147483648 }, params: { id: "campaign-1" } } as unknown as Request,
    overflow.response,
    (() => undefined) as NextFunction,
  );
  assert.equal(overflow.result.statusCode, 400);
  assert.deepEqual(overflow.result.body, {
    error: "minFollowers must be an integer between 0 and 2147483647",
  });

  // Boundary: exactly int4-max is allowed through (no early 400). It fails later
  // when it hits the mocked select — proving the validator did NOT reject it.
  const atMax = responseRecorder();
  await patch(
    { body: { minFollowers: 2147483647 }, params: { id: "campaign-1" } } as unknown as Request,
    atMax.response,
    (() => undefined) as NextFunction,
  );
  assert.notEqual(atMax.result.statusCode, 400, "int4-max must pass validation");
});
