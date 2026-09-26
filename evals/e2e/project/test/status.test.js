import assert from "node:assert/strict";
import { test } from "node:test";
import { statusBadge, statusLabel } from "../src/status.js";

test("labels a blocked project", () => {
  assert.equal(statusLabel("RED"), "Blocked");
});

test("a blocked project is red", () => {
  assert.deepEqual(statusBadge("RED"), { label: "Blocked", color: "#d33" });
});
