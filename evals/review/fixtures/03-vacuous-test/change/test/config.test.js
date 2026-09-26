const assert = require("node:assert/strict");
const { test } = require("node:test");
const config = require("../src/config");

test("the HTTP timeout defaults to five seconds", () => {
  assert.equal(config.http.timeoutMs ?? config.DEFAULT_TIMEOUT_MS, 5000);
});
