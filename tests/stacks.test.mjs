import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../hooks/dispatch.mjs";
import { effectIds, effectiveSteps, guardsFor, loadStack, stacksDir, StackError } from "../lib/stack.mjs";
import { planSteps, unreachableSteps } from "../lib/steps.mjs";
import { cleanupFixtures } from "./helpers/fixture.mjs";
import { kilnProject, payload } from "./helpers/project.mjs";

after(cleanupFixtures);

const stackIds = () => readdirSync(stacksDir()).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""));

const BLOCK = 2;
const ALLOW = 0;

test("D10 / §3d: a stack adapter is a JSON file and nothing else", () => {
  const node = loadStack("node");
  assert.deepEqual(node.guards, [], "zero guards");
  assert.deepEqual(node.effects, [], "zero effects");
  assert.deepEqual(node.steps.map((s) => s.id), ["unit"], "the one step every Node project has");
});

test("D40: a stack's steps are a default the project's own config replaces", () => {
  const stack = loadStack("node");
  assert.deepEqual(effectiveSteps(stack, {}).map((s) => s.id), ["unit"], "no config, the default stands");

  const detected = { stack: { steps: [{ id: "typecheck", run: "x" }, { id: "unit", run: "y" }] } };
  assert.deepEqual(effectiveSteps(stack, detected).map((s) => s.id), ["typecheck", "unit"]);
});

test("P2 bankruptcy observable: non-guard code in a stack is zero lines", () => {
  const listed = new Set();
  for (const file of readdirSync(stacksDir()).filter((name) => name.endsWith(".json"))) {
    for (const guard of loadStack(file.replace(/\.json$/, "")).guards ?? []) listed.add(guard.script);
  }

  const code = readdirSync(stacksDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) => readdirSync(join(stacksDir(), dir.name)).map((name) => `${dir.name}/${name}`))
    .filter((relative) => relative.endsWith(".mjs"));

  for (const relative of code) {
    assert.ok(listed.has(relative), `${relative} is code a stack does not declare as a guard`);
  }
});

test("D30: an effect carries three fields and no more", () => {
  const [migrate] = loadStack("php-ci3").effects;
  assert.deepEqual(Object.keys(migrate).sort(), ["glyph", "hint", "id"]);
  assert.deepEqual(effectIds(loadStack("php-ci3")), ["migrate"]);
});

test("D61: the effect point is exercised by a second adapter, not just one", () => {
  assert.deepEqual(effectIds(loadStack("node")), [], "node declares none, which is the other point on the line");
  assert.equal(loadStack("php-ci3").effects.length, 1);
});

/** The mechanism, tested on its own steps: a preset's contents are not the contract. */
test("D29: a step whose required effect is absent is skipped with a reason, not failed", () => {
  const steps = [
    { id: "migrate", run: "m", provides: "migrate" },
    { id: "smoke", run: "s", requires: ["migrate"] },
  ];
  assert.equal(planSteps(steps, { phase: "full", effects: [] })[1].skipped, "requires migrate");
  assert.equal(planSteps(steps, { phase: "full", effects: ["migrate"] })[1].skipped, undefined);
});

/**
 * `unit` shipped as `requires: ["migrate"]`, which reads "run the tests only when this
 * change has a migration" — the opposite of what was meant, and the migrate step that
 * provides the effect is in a different phase, so in the phase that decides green the
 * project's only test step could never run. It did not, on a real project.
 */
test("no shipped stack carries a step that can never run", () => {
  for (const id of stackIds()) {
    const stranded = unreachableSteps(loadStack(id).steps);
    assert.deepEqual(stranded, [], `${id}: ${stranded.map((row) => `${row.step} requires ${row.effect}`).join(", ")}`);
  }
});

test("the full phase of php-ci3 runs its tests without waiting for a migration", () => {
  const planned = planSteps(loadStack("php-ci3").steps, { phase: "full", effects: [] });
  assert.deepEqual(planned.map((row) => row.step.id), ["unit"]);
  assert.equal(planned[0].skipped, undefined, "ordering comes from the array; requires comes from the change");
});

test("D29: phase splits which steps run inside IMPLEMENT", () => {
  const steps = loadStack("php-ci3").steps;
  assert.deepEqual(planSteps(steps, { phase: "fast", effects: [] }).map((p) => p.step.id), ["migrate"]);
  assert.deepEqual(planSteps(steps, { phase: "full", effects: [] }).map((p) => p.step.id), ["unit"]);
});

test("an unknown stack names the one thing you have to write", () => {
  assert.throws(() => loadStack("cobol"), (err) => err instanceof StackError && /stacks\/cobol\.json/.test(err.message));
});

test("guards are declared per phase, never discovered", () => {
  assert.deepEqual(guardsFor(loadStack("php-ci3"), "pre-edit").map((g) => g.id), ["migrations"]);
  assert.deepEqual(guardsFor(loadStack("php-ci3"), "post-edit").map((g) => g.id), ["php-lint"]);
  assert.deepEqual(guardsFor(loadStack("node"), "pre-edit"), []);
});

test("A2 / D30: destructive DDL is blocked by a guard script, never by a config regex", async () => {
  const project = kilnProject({ stack: "php-ci3", gates: { plan: "approved" } });
  const migration = join(project.root, "application", "migrations", "001_drop.php");

  const verdict = await dispatch("pre-edit", payload({
    file: migration,
    root: project.root,
    content: "$this->dbforge->drop_column('users', 'email');",
  }));
  assert.equal(verdict, BLOCK);
});

test("a migration that only adds is not the guard's business", async () => {
  const project = kilnProject({ stack: "php-ci3", gates: { plan: "approved" } });
  const migration = join(project.root, "application", "migrations", "002_add.php");

  const verdict = await dispatch("pre-edit", payload({
    file: migration,
    root: project.root,
    content: "$this->dbforge->add_column('users', ['email' => ['type' => 'VARCHAR']]);",
  }));
  assert.equal(verdict, ALLOW);
});

test("the same DDL outside a migrations directory is not this guard's concern", async () => {
  const project = kilnProject({ stack: "php-ci3", gates: { plan: "approved" } });
  const verdict = await dispatch("pre-edit", payload({
    file: join(project.root, "src", "notes.md"),
    root: project.root,
    content: "we should never DROP TABLE users",
  }));
  assert.equal(verdict, ALLOW, "a sentence about a danger is not the danger");
});

test("a DELETE with no WHERE is the same loss by another verb", async () => {
  const project = kilnProject({ stack: "php-ci3", gates: { plan: "approved" } });
  const verdict = await dispatch("pre-edit", payload({
    file: join(project.root, "migrations", "003_purge.php"),
    root: project.root,
    content: "$this->db->query('DELETE FROM sessions');",
  }));
  assert.equal(verdict, BLOCK);
});

test("a node project runs no stack guards at all", async () => {
  const project = kilnProject({ stack: "node", gates: { plan: "approved" } });
  const verdict = await dispatch("pre-edit", payload({
    file: join(project.root, "migrations", "001_drop.php"),
    root: project.root,
    content: "DROP TABLE users;",
  }));
  assert.equal(verdict, ALLOW, "php-ci3's guard belongs to php-ci3");
});

test("D33: a stack guard that crashes blocks, and the message names the file", async () => {
  const project = kilnProject({ stack: "broken", gates: { plan: "approved" } });
  const broken = join(stacksDir(), "broken.json");

  writeFileSync(broken, JSON.stringify({
    id: "broken",
    guards: [{ id: "explodes", phase: "pre-edit", script: "broken/explodes.mjs" }],
  }));
  mkdirSync(join(stacksDir(), "broken"), { recursive: true });
  writeFileSync(join(stacksDir(), "broken", "explodes.mjs"), "export function check() { throw new Error('boom'); }\n");

  try {
    const verdict = await dispatch("pre-edit", payload({ file: project.source, root: project.root }));
    assert.equal(verdict, BLOCK, "D33 has no exemption for project-contributed code");
  } finally {
    rmSync(broken, { force: true });
    rmSync(join(stacksDir(), "broken"), { recursive: true, force: true });
  }
});

test("D7 item 2: a stack guard sees a shell write, not only a Write tool call", async () => {
  const project = kilnProject({ stack: "php-ci3", gates: { plan: "approved" } });
  const migration = join(project.root, "application", "migrations", "001_drop.php");
  const ddl = "$this->dbforge->drop_column('users','email');";

  const viaWrite = await dispatch("pre-edit", {
    tool_input: { file_path: migration, content: ddl },
    cwd: project.root,
    session_id: "sess-under-test",
  });
  assert.equal(viaWrite, BLOCK);

  const viaRedirect = await dispatch("pre-bash", payload({ command: `echo "${ddl}" > ${migration}`, root: project.root }));
  assert.equal(viaRedirect, BLOCK, "the same DDL through the door D64 closed for core guards");
});

test("a shell write to a file the stack guard does not care about still passes", async () => {
  const project = kilnProject({ stack: "php-ci3", gates: { plan: "approved" } });
  const verdict = await dispatch("pre-bash", payload({ command: "echo hello > src/app.ts", root: project.root }));
  assert.equal(verdict, ALLOW);
});
