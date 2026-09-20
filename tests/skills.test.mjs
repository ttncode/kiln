import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKILLS = join(ROOT, "skills");

const AGGREGATE_CAP = 6000;
const PER_DESCRIPTION_WARN = 500;
const CHANGELOG_SHAPE = /v\d+\.\d+|\bchangelog\b|\brenumbered\b|\bretired\b/i;

function skillNames() {
  return existsSync(SKILLS) ? readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
}

function frontmatter(name) {
  const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
  const block = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(block, `${name}: SKILL.md has no frontmatter block`);
  const read = (key) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block[1])?.[1]?.replace(/^"|"$/g, "") ?? "";
  return { name: read("name"), description: read("description"), body: text };
}

test("every skill directory holds a SKILL.md with frontmatter", () => {
  for (const name of skillNames()) frontmatter(name);
});

test("D27: the frontmatter name matches its directory and is lowercase-hyphen", () => {
  for (const name of skillNames()) {
    assert.equal(frontmatter(name).name, name);
    assert.match(name, /^[a-z][a-z0-9-]*$/, `${name} is not lowercase-hyphen`);
  }
});

test("A11: the always-on description budget holds in aggregate", () => {
  const total = skillNames().reduce((sum, name) => sum + frontmatter(name).description.length, 0);
  assert.ok(total <= AGGREGATE_CAP, `descriptions total ${total} chars, cap is ${AGGREGATE_CAP}`);
});

test("A11: no single description passes the warning length", () => {
  for (const name of skillNames()) {
    const { description } = frontmatter(name);
    assert.ok(description.length <= PER_DESCRIPTION_WARN, `${name}: ${description.length} chars`);
  }
});

test("A11: a description carries trigger conditions, not a changelog", () => {
  for (const name of skillNames()) {
    const { description } = frontmatter(name);
    assert.doesNotMatch(description, CHANGELOG_SHAPE, `${name}: the routing slot is holding version history`);
    assert.match(description, /\buse when\b/i, `${name}: no trigger condition`);
  }
});

test("D27: a skill carries its rationalization table, red flags and verification", () => {
  for (const name of skillNames()) {
    const { body } = frontmatter(name);
    assert.match(body, /\| Excuse \| Reality \||\| Rationalization \| Reality \|/, `${name}: no rationalization table`);
    assert.match(body, /## Red Flags/, `${name}: no red flags`);
    assert.match(body, /## Verification/, `${name}: no verification`);
  }
});

/**
 * A forked skill carries the sibling files it used to sit beside. A pointer to one that
 * did not come with it fails the way agent-skills #361 describes: silently, at the
 * moment a user needs it.
 */
test("D69: every file a skill points at came with it", () => {
  for (const name of skillNames()) {
    const dir = join(SKILLS, name);
    const referenced = frontmatter(name).body.match(/\]\(([a-z0-9-]+\.(?:md|sh|mjs))\)/g) ?? [];
    for (const link of referenced) {
      const file = /\(([^)]+)\)/.exec(link)[1];
      assert.ok(existsSync(join(dir, file)), `${name} points at ${file}, which did not come with it`);
    }
  }
});

test("D69: a skill never names a superpowers skill kiln does not ship", () => {
  const shipped = new Set(skillNames());
  for (const name of skillNames()) {
    const referenced = frontmatter(name).body.match(/\bsuperpowers:[a-z-]+/g) ?? [];
    assert.deepEqual(referenced, [], `${name} references ${referenced.join(", ")}, which kiln does not ship`);
    for (const sibling of frontmatter(name).body.match(/\bkiln-[a-z-]+(?=\s+skill)/g) ?? []) {
      assert.ok(shipped.has(sibling), `${name} names ${sibling}, which is not a skill kiln ships`);
    }
  }
});

test("§1.6 row 2: if hooks are registered, the wrapped shape is the only one that works", () => {
  const path = join(ROOT, "hooks", "hooks.json");
  if (!existsSync(path)) return;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(parsed.hooks, "the flat top-level form registers nothing, silently");
  assert.match(JSON.stringify(parsed), /NotebookEdit/, "§1.6 row 5: the edit matcher must name it");
});

test("the plugin manifest parses and names the repository", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "kiln");
  assert.equal(manifest.license, "MIT");
});
