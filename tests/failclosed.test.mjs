/**
 * D33: a guard fails open only when it can prove there is nothing to protect. Each test here
 * is a way the proof was faked — something kiln could not read, answered as if it were not
 * there — and cc-safety-net's failure-injection suite is the shape: break the dependency,
 * assert the verdict *and* the reason.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cleanupFixtures, git, tempRoot } from "./helpers/fixture.mjs";
import { SESSION, kiln, nodeProject, ok, throughPlanGate } from "./helpers/journey.mjs";
import { judge, spawnHook } from "./helpers/hook.mjs";
import { kilnProject, payload } from "./helpers/project.mjs";
import { installFloor, runnerPath } from "../lib/floor.mjs";

after(cleanupFixtures);

const DENY = 2;
const ALLOW = 0;
const edit = (root, file, session = SESSION) => judge("pre-edit", { session_id: session, cwd: root, tool_input: { file_path: join(root, file) } });
const bash = (root, command, session = SESSION) => judge("pre-bash", { session_id: session, cwd: root, tool_input: { command } });
const asRoot = process.getuid?.() === 0;

test("a work directory kiln cannot read blocks; it does not disappear", { skip: asRoot && "root reads through chmod 000" }, async () => {
  const root = nodeProject({ name: "eacces" });
  ok(root, ["open", "w1", "--session", SESSION]);
  const dir = join(root, ".kiln", "work", "w1");
  chmodSync(dir, 0o000);
  try {
    const verdict = await edit(root, "src/app.js");
    assert.equal(verdict.status, DENY);
    assert.match(verdict.stderr, /cannot be read \(EACCES\)/);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("a config that is there and unreadable stops writes, and says why", async () => {
  const root = nodeProject({ name: "corrupt" });
  writeFileSync(join(root, ".kiln", "config.json"), "{ this is not json");
  const write = await edit(root, "src/app.js");
  assert.equal(write.status, DENY);
  assert.match(write.stderr, /config\.json cannot be read/);
  assert.doesNotMatch(write.stderr, /bug in kiln/);
  assert.equal((await bash(root, "echo x > src/app.js")).status, DENY);
  assert.equal((await bash(root, "cat .kiln/config.json && kiln doctor")).status, ALLOW, "reading and diagnosing carry on");
  assert.equal((await bash(root, "git push origin main")).status, DENY, "the fallback list still protects main");
});

test("a corrupt config does not switch a project's stack guards off", async () => {
  const project = kilnProject({ stack: "php-ci3", gates: { plan: "approved" } });
  const migration = join(project.root, "application", "migrations", "001_drop.php");
  const ddl = { session_id: "sess-under-test", cwd: project.root, tool_input: { file_path: migration, content: "$this->dbforge->drop_column('users','email');" } };
  assert.equal((await judge("pre-edit", ddl)).status, DENY, "the guard, with the file intact");
  writeFileSync(join(project.root, ".kiln", "config.json"), "\uFEFF{ broken");
  assert.equal((await judge("pre-edit", ddl)).status, DENY, "and with the file broken");
});

test("a config with a byte-order mark is read, not treated as broken", async () => {
  const root = nodeProject({ name: "bom" });
  const path = join(root, ".kiln", "config.json");
  writeFileSync(path, `\uFEFF${readFileSync(path, "utf8")}`);
  assert.equal((await bash(root, "git push origin feature/x")).status, ALLOW);
  assert.equal((await edit(root, "src/app.js")).status, ALLOW);
});

test("a project reached through a symlinked directory is still the same project", async () => {
  const root = nodeProject({ name: "linked" });
  const link = join(tempRoot("kiln-link-"), "project");
  symlinkSync(root, link);
  throughPlanGate(root, "w1");
  const via = (file) => judge("pre-edit", { session_id: SESSION, cwd: link, tool_input: { file_path: join(link, file) } });
  assert.equal((await via("src/app.js")).status, ALLOW, "source, through the link, after the gate");
  assert.equal((await via(".kiln/config.json")).status, DENY, "and kiln's own file is still kiln's");
});

test("a running work outranks a parked one bound to the same session", async () => {
  for (const [parked, running] of [["a1", "b2"], ["b2", "a1"]]) {
    const root = nodeProject({ name: `parked-${parked}` });
    ok(root, ["open", parked, "--session", SESSION]);
    ok(root, ["halt", parked, "--reason", "waiting on the user"]);
    throughPlanGate(root, running, { predicted: "src/app.js" });
    const verdict = await edit(root, "src/app.js");
    assert.equal(verdict.status, ALLOW, `${parked} parked, ${running} running: ${verdict.stderr}`);
  }
});

test("a stack guard with no check function blocks, naming its file", async () => {
  const stacks = new URL("../stacks/", import.meta.url).pathname;
  const id = "failclosed-nocheck";
  writeFileSync(join(stacks, `${id}.json`), JSON.stringify({ id, guards: [{ id: "silent", phase: "pre-edit", script: `${id}/silent.mjs` }] }));
  mkdirSync(join(stacks, id), { recursive: true });
  writeFileSync(join(stacks, id, "silent.mjs"), "export const nothing = 1;\n");
  try {
    const project = kilnProject({ stack: id, gates: { plan: "approved" } });
    const verdict = await judge("pre-edit", payload({ file: project.source, root: project.root }));
    assert.equal(verdict.status, DENY);
    assert.match(verdict.stderr, /silent\.mjs/);
    assert.match(verdict.stderr, /kiln doctor/);
  } finally {
    rmSync(join(stacks, `${id}.json`), { force: true });
    rmSync(join(stacks, id), { recursive: true, force: true });
  }
});

test("a stack guard whose check rejects blocks, naming its file rather than blaming kiln", async () => {
  const stacks = new URL("../stacks/", import.meta.url).pathname;
  const id = "failclosed-async";
  writeFileSync(join(stacks, `${id}.json`), JSON.stringify({ id, guards: [{ id: "later", phase: "pre-edit", script: `${id}/later.mjs` }] }));
  mkdirSync(join(stacks, id), { recursive: true });
  writeFileSync(join(stacks, id, "later.mjs"), "export async function check() { throw new Error('boom'); }\n");
  try {
    const project = kilnProject({ stack: id, gates: { plan: "approved" } });
    const verdict = await judge("pre-edit", payload({ file: project.source, root: project.root }));
    assert.equal(verdict.status, DENY);
    assert.match(verdict.stderr, /later\.mjs/);
    assert.doesNotMatch(verdict.stderr, /bug in kiln/);
  } finally {
    rmSync(join(stacks, `${id}.json`), { force: true });
    rmSync(join(stacks, id), { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- the real process

test("the hook as the harness runs it: a separate process, JSON on stdin, exit 2 to block", () => {
  const root = nodeProject({ name: "spawned" });
  const refused = spawnHook("pre-bash", { session_id: SESSION, cwd: root, tool_input: { command: "git push origin main" } });
  assert.equal(refused.status, DENY);
  assert.match(refused.stderr, /protected branch/);
  const allowed = spawnHook("pre-bash", { session_id: SESSION, cwd: root, tool_input: { command: "git status" } });
  assert.equal(allowed.status, ALLOW);
});

/**
 * Deliberately open, and asserted so it stays deliberate. Input that is not JSON means the
 * harness itself is broken, and refusing every tool call in that state bricks the session
 * without protecting anything; dcg makes the same call, cc-safety-net the opposite one.
 */
test("stdin that is not JSON is the harness's fault, and is allowed", () => {
  assert.equal(spawnHook("pre-bash", "not json").status, ALLOW);
});

// ------------------------------------------------------------- the floor

function floorRun(root, stdin) {
  return spawnSync(process.execPath, [runnerPath(root)], { cwd: root, input: stdin, encoding: "utf8" });
}

test("the floor reads a config with a byte-order mark and refuses a push to main", () => {
  const root = nodeProject({ name: "floor-bom" });
  installFloor(root);
  const path = join(root, ".kiln", "config.json");
  writeFileSync(path, `\uFEFF${readFileSync(path, "utf8")}`);
  assert.equal(floorRun(root, "refs/heads/x 1 refs/heads/main 0\n").status, 1);
  assert.equal(floorRun(root, "refs/heads/x 1 refs/heads/x 0\n").status, 0);
});

test("the floor refuses a push it cannot judge, because its config cannot be read", () => {
  const root = nodeProject({ name: "floor-corrupt" });
  installFloor(root);
  writeFileSync(join(root, ".kiln", "config.json"), "{ broken");
  const run = floorRun(root, "refs/heads/x 1 refs/heads/x 0\n");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /cannot be read/);
});

test("the floor protects the branch the project ships from, as the guard does", () => {
  const root = nodeProject({ name: "floor-integration" });
  git(root, ["checkout", "-q", "-b", "v3-master"]);
  ok(root, ["config", "set", "vcs.integration_branch=v3-master"]);
  installFloor(root);
  assert.equal(floorRun(root, "refs/heads/x 1 refs/heads/v3-master 0\n").status, 1);
});

test("an out-of-date runner is replaced by doctor --write, and open says it is stale first", () => {
  const root = nodeProject({ name: "floor-stale" });
  installFloor(root);
  writeFileSync(runnerPath(root), "// an older kiln wrote this\n");
  const opened = kiln(root, ["open", "w1", "--session", SESSION]);
  assert.match(opened.stderr, /not armed.*stale/s);
  ok(root, ["doctor", "--write"]);
  assert.notEqual(readFileSync(runnerPath(root), "utf8"), "// an older kiln wrote this\n");
});

// ------------------------------------------------------------- the law, checked statically

/**
 * No core guard may have a failure branch ending in ALLOW once the dispatcher is running
 * (D33, D54). Stated since the design and never checked, which is how four such branches got
 * in. Every `catch` in the guard layer must throw, block, or carry a `fail-open:` comment
 * saying why the thing it swallowed proves there is nothing to protect.
 */
test("D33: every catch in the guard layer throws, blocks, or says why it may open", () => {
  const files = [
    new URL("../hooks/dispatch.mjs", import.meta.url).pathname,
    new URL("../lib/paths.mjs", import.meta.url).pathname,
    ...readdirSync(new URL("../lib/guards/", import.meta.url).pathname).map((name) => new URL(`../lib/guards/${name}`, import.meta.url).pathname),
  ];
  const unexplained = files.flatMap((file) => catchBodies(readFileSync(file, "utf8")).filter((body) => !closes(body)).map((body) => `${file}: ${body.split("\n")[0]}`));
  assert.deepEqual(unexplained, []);
});

function catchBodies(source) {
  return [...source.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)].map((match) => {
    let depth = 1;
    let at = match.index + match[0].length;
    while (depth > 0 && at < source.length) {
      if (source[at] === "{") depth += 1;
      if (source[at] === "}") depth -= 1;
      at += 1;
    }
    return source.slice(match.index, at);
  });
}

function closes(body) {
  return /\bthrow\b|\bblock\(|blocked: true|fail-(?:open|closed):/.test(body);
}
