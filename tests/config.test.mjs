import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ConfigError,
  DEFAULTS,
  checkSchema,
  deepMerge,
  findRoot,
  integrationBranch,
  loadConfig,
  parseJsonText,
} from "../lib/config.mjs";
import { cleanupFixtures, tempRoot, writeConfig } from "./helpers/fixture.mjs";

after(cleanupFixtures);

test("B05: a byte-order mark parses instead of reading as a broken config", () => {
  assert.deepEqual(parseJsonText('﻿{"a":1}'), { a: 1 });
});

test("B05: CRLF survives the read untouched", () => {
  const root = tempRoot();
  const path = join(root, ".kiln", "config.json");
  mkdirSync(join(root, ".kiln"), { recursive: true });
  writeFileSync(path, '﻿{\r\n  "artifact_language": "vi"\r\n}\r\n', "utf8");
  assert.equal(loadConfig(root).config.artifact_language, "vi");
});

test("defaults fill every key the file omits", () => {
  const root = tempRoot();
  writeConfig(root, { vcs: { protected: ["v3-master"] } });
  const { config } = loadConfig(root);
  assert.deepEqual(config.vcs.protected, ["v3-master"]);
  assert.equal(config.vcs.branch_pattern, DEFAULTS.vcs.branch_pattern);
  assert.equal(config.work.committed, true);
});

test("D73: there is no verify provider to configure", () => {
  assert.equal("verify" in DEFAULTS, false);
});

test("deepMerge replaces arrays rather than concatenating them", () => {
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
});

test("D38: discovery walks up, so a deep cwd finds the workspace root", () => {
  const root = tempRoot();
  writeConfig(root, {});
  const deep = join(root, "AdminPage", "application", "controllers");
  mkdirSync(deep, { recursive: true });
  assert.equal(findRoot(deep), root);
});

test("discovery returns null rather than guessing when there is no config", () => {
  assert.equal(findRoot(tempRoot()), null);
});

test("D39: an older schema migrates in memory and reports that it did", () => {
  const { migrated, foundVersion } = checkSchema(0);
  assert.equal(migrated, true);
  assert.equal(foundVersion, 0);
});

test("D39: a newer schema is refused, and the message carries both numbers", () => {
  assert.throws(() => checkSchema(99), (err) => /99/.test(err.message) && /1/.test(err.message));
});

test("D39: loading never rewrites the file it migrated", () => {
  const root = tempRoot();
  const path = writeConfig(root, { schema_version: 0, artifact_language: "vi" });
  const { migrated, config } = loadConfig(root);

  assert.equal(migrated, true);
  assert.equal(config.schema_version, 1, "the in-memory copy is current");
  assert.equal(parseJsonText(readFileSync(path, "utf8")).schema_version, 0, "the tracked file is not touched");
});

test("a missing config names the fix rather than throwing a parse error", () => {
  assert.throws(() => loadConfig(tempRoot()), ConfigError);
});

test("D81: integration_branch resolves per module and falls back for unlisted ones", () => {
  const mapped = { vcs: { integration_branch: { "admin-page": "v3-master" } } };
  assert.equal(integrationBranch(mapped, "admin-page"), "v3-master");
  assert.equal(integrationBranch(mapped, "common-models"), "main");
});

test("D81: a scalar still answers for every module", () => {
  const scalar = { vcs: { integration_branch: "develop" } };
  assert.equal(integrationBranch(scalar, "anything"), "develop");
});

/**
 * These two assert TERMINATION, which is the bug they were written for: the walk used to
 * converge on "." and never reach its stop condition.
 *
 * They used to assert `null`, which is only true when the working directory happens to
 * have no `.kiln/` above it — so they failed the moment anyone ran `kiln init` on the
 * kiln repository, which is the first thing a contributor does. Found by dogfooding.
 * A test that cannot pass in the repository it ships from is a test about the
 * environment, not about the code.
 */
function terminates(path) {
  const found = findRoot(path);
  assert.notEqual(found, ".", "`.` is where the old walk converged and spun forever");
  assert.ok(found === null || isAbsolute(found), `findRoot returned ${found}`);
}

test("findRoot terminates on a relative path, where parse().root is empty", () => {
  terminates("some/relative/path");
});

test("findRoot terminates on a malformed path rather than spinning", () => {
  terminates(String.fromCharCode(0) + "invalid");
});

test("findRoot returns null when no ancestor holds a config", () => {
  const root = join(tempRoot(), "nested", "deeper");
  assert.equal(findRoot(root), null, "an absolute path is not affected by where the tests run");
});
