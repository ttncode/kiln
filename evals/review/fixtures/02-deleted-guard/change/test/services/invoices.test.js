const assert = require("node:assert/strict");
const { test, mock } = require("node:test");
const db = require("../../src/db");
const { updateInvoice } = require("../../src/services/invoices");

test("only the editable fields are written", async () => {
  const update = mock.method(db.invoices, "update", async (id, fields) => ({ id, ...fields }));
  await updateInvoice({ id: 7 }, { note: "late", total: 0 });
  assert.deepEqual(update.mock.calls[0].arguments, [7, { note: "late" }]);
});
