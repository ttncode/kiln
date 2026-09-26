const assert = require("node:assert/strict");
const { test } = require("node:test");
const { statusLabel, statusBadge } = require("../src/status");

test("labels a blocked project", () => {
  assert.equal(statusLabel("RED"), "Blocked");
});

test("a blocked project gets a red stop badge", () => {
  assert.deepEqual(statusBadge("RED"), { label: "Blocked", color: "#d33", icon: "stop" });
});

test("an at-risk project gets an amber warning badge", () => {
  assert.deepEqual(statusBadge("YELLOW"), { label: "At risk", color: "#e90", icon: "warn" });
});
