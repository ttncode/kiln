import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * The README's first instruction is `/plugin marketplace add ttncode/kiln`, and that
 * needs a marketplace manifest. Without one the documented install fails at step one —
 * which is the whole of D6's first ten minutes.
 */
test("the marketplace manifest exists and agrees with the plugin", () => {
  const market = JSON.parse(readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const [entry] = market.plugins;

  assert.equal(entry.name, manifest.name);
  assert.equal(entry.version, manifest.version, "version-sync reaches every manifest, not two of three");
  assert.equal(entry.description, manifest.description);
});

test("D184: `npm version` moves both plugin manifests with package.json", () => {
  assert.match(pkg.scripts.version, /^node scripts\/version-sync\.mjs /);
  const dir = mkdtempSync(join(tmpdir(), "kiln-version-"));
  cpSync(new URL("../.claude-plugin", import.meta.url), join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9-rc.1" }));
  const run = spawnSync(process.execPath, [new URL("../scripts/version-sync.mjs", import.meta.url).pathname], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const read = (name) => JSON.parse(readFileSync(join(dir, ".claude-plugin", name), "utf8"));
  assert.equal(read("plugin.json").version, "9.9.9-rc.1");
  assert.equal(read("marketplace.json").plugins[0].version, "9.9.9-rc.1");
});

test("every manifest carries the description the repository advertises", () => {
  const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(manifest.description), "a manifest describing an older product is a second front page");
  assert.equal(pkg.description, manifest.description, "package.json is a third front page and drifts the same way");
});
