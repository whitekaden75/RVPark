import test from "node:test";
import assert from "node:assert/strict";
import { registerBookkeepingRoutes } from "./bookkeeping.js";

function routesWith(pool, notify) {
  const routes = new Map();
  const app = Object.fromEntries(["get", "post", "patch", "delete"].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))]));
  registerBookkeepingRoutes(app, { pool, notify });
  return routes;
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
}

test("approval notifies clients after both the transaction and document are updated", async () => {
  const events = [];
  const pool = { query: async sql => {
    if (sql.startsWith("UPDATE bookkeeping_transactions")) { events.push("transaction saved"); return { rowCount: 1, rows: [{ id: 1, status: "approved" }] }; }
    if (sql.startsWith("UPDATE bookkeeping_documents")) { events.push("document updated"); return { rowCount: 1, rows: [] }; }
    throw new Error("Unexpected query");
  } };
  const routes = routesWith(pool, event => { assert.equal(event.reason, "bookkeeping_changed"); events.push("notified"); });
  const res = response();
  await routes.get("patch /api/bookkeeping/transactions/:id")({ body: { status: "approved" }, params: { id: 1 }, adminUser: { id: 1 } }, res);
  assert.deepEqual(events, ["transaction saved", "document updated", "notified"]);
  assert.equal(res.body.transaction.status, "approved");
});

test("category additions broadcast an update and missing transaction deletes do not", async () => {
  const events = [];
  const pool = { query: async sql => sql.startsWith("INSERT") ? { rows: [{ id: 4, name: "Landscaping", category_type: "expense" }] } : { rowCount: 0, rows: [] } };
  const routes = routesWith(pool, event => events.push(event.reason));
  await routes.get("post /api/bookkeeping/categories")({ body: { name: "Landscaping" } }, response());
  const res = response();
  await routes.get("delete /api/bookkeeping/transactions/:id")({ params: { id: 99 } }, res);
  assert.deepEqual(events, ["bookkeeping_changed"]);
  assert.equal(res.statusCode, 404);
});

test("transaction lists retain the requested status filter", async () => {
  const calls = [];
  const routes = routesWith({ query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } }, () => {});
  for (const status of ["pending", "approved", "all"]) {
    await routes.get("get /api/bookkeeping/transactions")({ query: { status } }, response());
  }
  assert.deepEqual(calls.map(call => call.params), [["pending"], ["approved"], []]);
  assert.match(calls[0].sql, /t.status = \$1/);
  assert.match(calls[2].sql, /t.status <> 'void'/);
});
