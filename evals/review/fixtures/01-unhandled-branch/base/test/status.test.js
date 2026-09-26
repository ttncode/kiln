const assert = require("node:assert/strict");
const { test } = require("node:test");
const { statusLabel } = require("../src/status");

test("labels a blocked project", () => {
  assert.equal(statusLabel("RED"), "Blocked");
});
