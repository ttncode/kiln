import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const README = readFileSync(join(ROOT, "README.md"), "utf8");

function slug(heading) {
  return heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

test("every relative link in the README points at a file that exists", () => {
  const links = [...README.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1].split("#")[0]);
  for (const target of new Set(links.filter(Boolean))) {
    assert.ok(existsSync(join(ROOT, target)), `README links to ${target}, which does not exist`);
  }
});

test("every table-of-contents anchor resolves to a heading", () => {
  const headings = new Set([...README.matchAll(/^#{2,6}\s+(.*)$/gm)].map((m) => slug(m[1])));
  for (const anchor of new Set([...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]))) {
    assert.ok(headings.has(anchor), `README links to #${anchor}, which is not a heading`);
  }
});

/**
 * The README quotes numbers a reader will check. Drift here is not cosmetic: it is the
 * front door claiming something the repository stopped doing.
 */
test("the README's countable claims still hold", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.match(README, /zero runtime dependencies/i);
  assert.equal(Object.keys(pkg.dependencies).length, 0);

  assert.match(README, /Node 20\.10 or newer/);
  assert.equal(pkg.engines.node, ">=20.10.0");

  const stack = JSON.parse(readFileSync(join(ROOT, "stacks", "node.json"), "utf8"));
  assert.deepEqual(stack.steps.map((s) => s.id), ["unit"], "the README prints this file verbatim");
});

test("the README does not claim a release bar it has not met", () => {
  assert.match(README, /Status: pre-release/);
  assert.match(README, /acceptance runs/, "the outstanding half has to stay visible");
});
