import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("kiln ships zero runtime dependencies", () => {
  assert.deepEqual(pkg.dependencies, {}, "D2: hooks run on every tool call, so nothing is installed at runtime");
});

test("the engine floor admits the measured node version", () => {
  assert.match(pkg.engines.node, /^>=20\./);
});
