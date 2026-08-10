/**
 * PLU-154 route-level contract: resolving a manual-review case REQUIRES a
 * resolvedBy (the human's name) — approve / reject / opt-out each 400 without it,
 * and never touch the DB. This is the attribution guarantee PLU-153's close route
 * was measured against in review; pinning it here keeps both flows honest.
 *
 * The resolution logic itself is covered in db/manualReview.db.test.ts; this only
 * pins the thin HTTP guard.
 *
 * Run: node --import tsx --test src/routes/manualReviewResolve.route.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { db } from "../db/drizzle.js";
import router from "./manualQueue.js";

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: RequestHandler }>;
  };
};

function routeHandler(path: string): RequestHandler {
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods["post"],
  );
  assert.ok(layer?.route, `POST ${path} route must exist`);
  return layer.route.stack[0]!.handle;
}

function responseRecorder(): {
  response: Response;
  result: { statusCode: number; body: unknown };
} {
  const result = { statusCode: 200, body: undefined as unknown };
  const response = {} as Response;
  response.status = ((code: number) => {
    result.statusCode = code;
    return response;
  }) as Response["status"];
  response.json = ((body: unknown) => {
    result.body = body;
    return response;
  }) as Response["json"];
  return { response, result };
}

const RESOLVE_PATHS = [
  "/instances/:instanceId/manual-review/approve",
  "/instances/:instanceId/manual-review/reject",
  "/instances/:instanceId/manual-review/opt-out",
];

for (const path of RESOLVE_PATHS) {
  test(`${path}: missing resolvedBy → 400 (never touches the DB)`, async (t) => {
    const handler = routeHandler(path);
    // The 400 must short-circuit before any DB work — stub both entry points the
    // handlers could hit and assert neither fires.
    const mockDb = db as unknown as {
      select: (...a: unknown[]) => unknown;
      transaction: (...a: unknown[]) => unknown;
    };
    let dbTouched = false;
    t.mock.method(mockDb, "select", () => {
      dbTouched = true;
      return { from: () => ({ where: () => ({ limit: async () => [] }) }) };
    });
    t.mock.method(mockDb, "transaction", async () => {
      dbTouched = true;
    });

    const r = responseRecorder();
    await handler(
      { params: { instanceId: "i1" }, body: { reason: "no name given" } } as unknown as Request,
      r.response,
      (() => undefined) as NextFunction,
    );

    assert.equal(r.result.statusCode, 400);
    assert.match((r.result.body as { error: string }).error, /resolvedBy is required/);
    assert.equal(dbTouched, false, "must not touch the DB when resolvedBy is missing");
  });
}
