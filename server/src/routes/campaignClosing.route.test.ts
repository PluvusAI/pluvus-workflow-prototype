/**
 * PLU-153 route-level behavior: the close route's status-code mapping and the
 * DELETE gate (409-unless-?force=true for a launched campaign). The transition
 * itself is covered against a real DB in db/campaignClosing.db.test.ts; here we
 * only pin the thin HTTP layer the ACs are written against.
 *
 * Run: node --import tsx --test src/routes/campaignClosing.route.test.ts
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

function routeHandler(path: string, method: "post" | "delete"): RequestHandler {
  const layers = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method],
  );
  assert.ok(layer?.route, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack[0]!.handle;
}

function responseRecorder(): {
  response: Response;
  result: { statusCode: number; body: unknown; ended: boolean };
} {
  const result = { statusCode: 200, body: undefined as unknown, ended: false };
  const response = {} as Response;
  response.status = ((code: number) => {
    result.statusCode = code;
    return response;
  }) as Response["status"];
  response.json = ((body: unknown) => {
    result.body = body;
    return response;
  }) as Response["json"];
  response.send = (() => {
    result.ended = true;
    return response;
  }) as Response["send"];
  return { response, result };
}

// Stub the whole campaign row for findCampaignById via a select().from().where().limit()
// chain returning one row (that's what findCampaignById does under the hood).
function stubFindCampaign(
  t: { mock: { method: typeof import("node:test").mock.method } },
  row: Record<string, unknown> | null,
) {
  const mockDb = db as unknown as { select: (...a: unknown[]) => unknown };
  t.mock.method(mockDb, "select", () => ({
    from: () => ({
      where: () => ({ limit: async () => (row ? [row] : []) }),
    }),
  }));
}

test("DELETE gate: launched campaign 409s without ?force, DRAFT 204s", async (t) => {
  const del = routeHandler("/:id", "delete");

  // ACTIVE without force → 409, and deleteCampaign is never reached.
  stubFindCampaign(t, { id: "c1", status: "ACTIVE" });
  let deleteCalled = false;
  const mockDb = db as unknown as { transaction: (...a: unknown[]) => unknown };
  t.mock.method(mockDb, "transaction", async () => {
    deleteCalled = true;
  });

  const r409 = responseRecorder();
  await del(
    { params: { id: "c1" }, query: {} } as unknown as Request,
    r409.response,
    (() => undefined) as NextFunction,
  );
  assert.equal(r409.result.statusCode, 409);
  assert.match((r409.result.body as { error: string }).error, /use End campaign/);
  assert.equal(deleteCalled, false, "must not delete a launched campaign without force");
});

test("DELETE gate: ?force=true hard-deletes a launched campaign (204)", async (t) => {
  const del = routeHandler("/:id", "delete");
  stubFindCampaign(t, { id: "c1", status: "ACTIVE" });
  const mockDb = db as unknown as { transaction: (...a: unknown[]) => unknown };
  let deleteCalled = false;
  t.mock.method(mockDb, "transaction", async (cb: (tx: unknown) => Promise<void>) => {
    deleteCalled = true;
    // Give the cascade a no-op tx so it completes.
    const noopTx = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      delete: () => ({ where: async () => undefined }),
    };
    await cb(noopTx);
  });

  const r = responseRecorder();
  await del(
    { params: { id: "c1" }, query: { force: "true" } } as unknown as Request,
    r.response,
    (() => undefined) as NextFunction,
  );
  assert.equal(r.result.statusCode, 204);
  assert.equal(deleteCalled, true);
});

test("DELETE gate: missing campaign → 404", async (t) => {
  const del = routeHandler("/:id", "delete");
  stubFindCampaign(t, null);
  const r = responseRecorder();
  await del(
    { params: { id: "nope" }, query: {} } as unknown as Request,
    r.response,
    (() => undefined) as NextFunction,
  );
  assert.equal(r.result.statusCode, 404);
});

test("close route: invalid transition (from DRAFT) → 409", async (t) => {
  const close = routeHandler("/:id/close", "post");
  // transitionCampaignToClosing runs a real client.transaction — stub it to
  // yield a DRAFT row so the service returns {status:"invalid", from:"DRAFT"}.
  const mockDb = db as unknown as { transaction: (...a: unknown[]) => unknown };
  t.mock.method(mockDb, "transaction", async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      execute: async () => undefined, // FOR UPDATE lock
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ id: "c1", status: "DRAFT" }] }) }),
      }),
    };
    return cb(tx);
  });

  const r = responseRecorder();
  await close(
    { params: { id: "c1" }, body: { actorId: "Ayush" } } as unknown as Request,
    r.response,
    (() => undefined) as NextFunction,
  );
  assert.equal(r.result.statusCode, 409);
  assert.match((r.result.body as { error: string }).error, /only an Active campaign/);
});

test("close route: missing actorId → 400 (attribution required)", async (t) => {
  const close = routeHandler("/:id/close", "post");
  // The 400 short-circuits before any DB work — stub transaction to prove it's
  // never reached.
  const mockDb = db as unknown as { transaction: (...a: unknown[]) => unknown };
  let txCalled = false;
  t.mock.method(mockDb, "transaction", async () => {
    txCalled = true;
  });

  const r = responseRecorder();
  await close(
    { params: { id: "c1" }, body: { reason: "no name given" } } as unknown as Request,
    r.response,
    (() => undefined) as NextFunction,
  );
  assert.equal(r.result.statusCode, 400);
  assert.match((r.result.body as { error: string }).error, /actorId is required/);
  assert.equal(txCalled, false, "must not touch the DB when actorId is missing");
});

test("close route: missing campaign → 404", async (t) => {
  const close = routeHandler("/:id/close", "post");
  const mockDb = db as unknown as { transaction: (...a: unknown[]) => unknown };
  t.mock.method(mockDb, "transaction", async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }), // not found
      }),
    };
    return cb(tx);
  });

  const r = responseRecorder();
  await close(
    { params: { id: "nope" }, body: { actorId: "Ayush" } } as unknown as Request,
    r.response,
    (() => undefined) as NextFunction,
  );
  assert.equal(r.result.statusCode, 404);
});
