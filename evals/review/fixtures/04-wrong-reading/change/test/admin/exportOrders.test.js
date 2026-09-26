const assert = require("node:assert/strict");
const { test, mock } = require("node:test");
const db = require("../../src/db");
const { exportOrders } = require("../../src/admin/exportOrders");

test("archived orders are left out of the export", async () => {
  const query = mock.method(db, "query", async () => []);
  await exportOrders();
  assert.match(query.mock.calls[0].arguments[0], /archived = false/);
});
