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

test("D17: the plugin manifest and package.json agree on the version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, pkg.version, "version-sync: two manifests disagreeing is agent-skills #440");
});
