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
    assert.match(body, /\|\s*(?:Excuse|Rationalization|Thought)\s*\|\s*Reality\s*\|/, `${name}: no rationalization table`);
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

/**
 * Named namespaces rather than a `<word>:<word>` pattern, which cannot tell a skill
 * reference from `display:flex` or `font-family:system-ui`. Every fork records the
 * plugin it came from in NOTICE; this list is that record, enforced. A future fork adds
 * its namespace here, by the same discipline.
 */
const FOREIGN_NAMESPACES = ["superpowers", "elements-of-style", "agent-skills", "bmad"];

function skillFiles(name) {
  return readdirSync(join(SKILLS, name), { recursive: true })
    .filter((entry) => typeof entry === "string" && entry.endsWith(".md"))
    .map((entry) => join(SKILLS, name, entry));
}

test("D69: no page under a skill names a plugin kiln does not ship", () => {
  for (const name of skillNames()) {
    for (const path of skillFiles(name)) {
      const text = readFileSync(path, "utf8");
      for (const namespace of FOREIGN_NAMESPACES) {
        const found = text.match(new RegExp(`\\b${namespace}:[a-z][a-z-]+`, "g")) ?? [];
        assert.deepEqual(found, [], `${path} references ${found.join(", ")}`);
      }
    }
  }
});

test("D69: a skill only names sibling skills kiln actually ships", () => {
  const shipped = new Set(skillNames());
  for (const name of skillNames()) {
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

/**
 * A skill that describes a narrower product than the one that ships tells every user the
 * feature is missing. The orchestrator said "bounded only" for three phases after the
 * three paths landed, and an acceptance run caught it rather than a reader.
 */
test("the orchestrator describes every path the code actually supports", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  for (const path of ["spike", "bounded", "full"]) {
    assert.match(body, new RegExp(`\`${path}\``), `the orchestrator never mentions ${path}`);
  }
  assert.doesNotMatch(body, /walking skeleton/i, "a phase note that outlived its phase");
  assert.match(body, /ratchet/, "the way up a rung has to be in the skill that renders the paths");
});

/**
 * Acceptance run C4 hit a blocking unknown on the full path and recommended "drop to
 * spike" — a downward ratchet, which does not exist. The code refused it correctly; the
 * skill had told the agent the ratchet only goes up without saying what to do instead.
 */
test("the orchestrator names the move for a blocking unknown, not just the ban", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  assert.match(body, /never down/, "the ban still has to be stated");
  assert.match(body, /blocking[_ ]unknown/i, "and the thing to do instead has to be named");
  assert.match(body, /close this work and open a spike/i, "including the option that is the user's to take");
});

/**
 * The first real run typed `1` twice at a gate that offered numbered options and refused
 * numbers. The classifier is right — a bare `1` is a click, not a reading — so the menu
 * was the thing that had to go.
 */
test("a gate asks for a word, and does not offer a number it will refuse", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  const gate = body.slice(body.indexOf("GATE — plan"), body.indexOf("GATE — plan") + 400);

  assert.doesNotMatch(gate, /^\s+1\. /m, "a numbered menu invites a number");
  assert.match(gate, /Reply `approve`/, "and the gate has to say what it does accept");
  assert.match(body, /--predicted/, "the plan gate's claim set is not optional");
});

/**
 * The skill told the agent to let the user override the classification and never said
 * how: `open --path` exists in the CLI and appeared nowhere in the skill, so a spoken
 * `full` could only reach state through `kiln ratchet` — after opening on a path the
 * user did not choose, and at the cost of the gate records the ratchet clears.
 */
test("the orchestrator names the flag that carries a path override", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  assert.match(body, /open <id> --path/, "the override has to have a route into state");
  assert.match(body, /defaults to `bounded`/, "the default is a choice the agent makes silently otherwise");
});

/**
 * D69 checks that every file a skill points at came with it. The reverse went unchecked,
 * and two subagent prompts shipped that nothing dispatched: the spec reviewer was
 * referenced by nothing at all, and the code reviewer was linked as reading material, so
 * on the first real full-path run the implementer reviewed its own diff.
 */
test("every file that came with a skill is pointed at by it", () => {
  for (const name of skillNames()) {
    const body = frontmatter(name).body;
    const orphans = readdirSync(join(SKILLS, name))
      .filter((file) => file.endsWith(".md") && file !== "SKILL.md")
      .filter((file) => !body.includes(file));
    assert.deepEqual(orphans, [], `${name} ships ${orphans.join(", ")} and points at nothing`);
  }
});

test("a prompt written for a subagent is dispatched, not read aloud", () => {
  for (const [skill, prompt] of [["kiln-review", "code-reviewer.md"], ["kiln-brainstorming", "spec-document-reviewer-prompt.md"]]) {
    const template = readFileSync(join(SKILLS, skill, prompt), "utf8");
    assert.match(template, /dispatching a .* subagent/, `${prompt} no longer says it is a subagent prompt`);
    assert.match(frontmatter(skill).body, /Task\(subagent_type/, `${skill} reads ${prompt} instead of dispatching it`);
  }
});

test("the orchestrator offers a next move after a stage, and stopping is one of them", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  assert.match(body, /What would you like to do\?/);
  assert.match(body, /Option 3 always exists/, "stopping must not be the choice the user has to invent");
  assert.match(body, /Expand it to that option's text/, "a number is a label, not an answer");
});

test("a gate's options are sentences, because kiln reads the sentence", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  assert.match(body, /1\. Approve this plan as written/);
  assert.match(body, /a bare `1` does not/, "the option text is what the gate records");
});

test("the orchestrator says how to write, because a stage report is read for its numbers", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  assert.match(body, /Tables, numbered steps, short bullets/);
  assert.match(body, /Quote a tool's own error verbatim/);
});

test("the orchestrator knows auto mode exists and what a refusal means", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  assert.match(body, /--auto/, "the flag existed and nothing passed it");
  assert.match(body, /A refusal means ask\s+the user/, "a refused ruling is not a reason to record it another way");
});

/**
 * Offering `kiln doctor` as a next step, one run wrote that it "checks containers, make test
 * reachable, GitLab token". It checks none of those. Nobody asked for the list — the gap
 * where an authoritative one should have been got filled with a guess, and a guess about
 * what a safety tool verifies is worse than no answer.
 */
test("the orchestrator is told to run a command rather than describe it", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  assert.match(body, /Never describe what a command checks or does/);
  assert.match(body, /Run it and print what it said/);
});

/**
 * kiln ships seven skills. Measured across three real runs on a real project, exactly one
 * ever loaded — this one — while the other six sat unread and their stages were improvised
 * inside it. A skill nothing invokes is the same shape as a config field nothing reads,
 * except it is two thousand lines of it.
 */
test("the orchestrator invokes every skill kiln ships", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  for (const name of skillNames().filter((skill) => skill !== "kiln-orchestrator")) {
    assert.match(body, new RegExp(`\`${name}\``), `${name} ships and the orchestrator never names it`);
  }
});

test("each stage names the skill that does it, rather than restating it", () => {
  const body = readFileSync(join(SKILLS, "kiln-orchestrator", "SKILL.md"), "utf8");
  assert.match(body, /Use the `kiln-writing-plans` skill/);
  assert.match(body, /use the `kiln-brainstorming` skill/);
  assert.match(body, /Use the `kiln-implement` skill/);
  assert.match(body, /use the `kiln-review` skill/);
  assert.match(body, /Do not restate its contents here/, "a skill invoked and then paraphrased is a skill not used");
});
