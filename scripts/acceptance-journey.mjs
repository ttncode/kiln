#!/usr/bin/env node
/**
 * The journey matrix, run against a real repository instead of a fixture.
 *
 * Fixtures answer "does the mechanism work". A checkout somebody else designed answers
 * "does it work here" — which is the question every defect this project has found came
 * from. So this takes a real clone, runs the rows that need no package install, and prints
 * what happened.
 *
 * Usage: node scripts/acceptance-journey.mjs <repo> [<repo> ...]
 *
 * Safety: the first thing done to every repository is removing its `origin`. Nothing here
 * can reach the project's real remote, and the floor is exercised against a local bare
 * repository instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const BIN = new URL("../bin/kiln.mjs", import.meta.url).pathname;
const DISPATCH = new URL("../hooks/dispatch.mjs", import.meta.url).pathname;
const SESSION = "acceptance-session";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function kiln(cwd, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
}

function hook(cwd, { phase, toolInput }) {
  const payload = JSON.stringify({ session_id: SESSION, cwd, tool_input: toolInput });
  return spawnSync(process.execPath, [DISPATCH, phase], { input: payload, encoding: "utf8" }).status;
}

const bash = (cwd, command) => hook(cwd, { phase: "pre-bash", toolInput: { command } });
const edit = (cwd, file) => hook(cwd, { phase: "pre-edit", toolInput: { file_path: join(cwd, file) } });

/**
 * Nothing in this file may reach the project's real remote — that is the first half.
 *
 * The second half is that a run must start where a user starts. Re-running against a repo
 * that still held `.kiln/work/` from the last pass saw an already-approved plan gate and
 * reported the gate open when it should have been shut, so the leftovers go too.
 */
function detach(repo) {
  git(repo, ["remote", "remove", "origin"]);
  rmSync(join(repo, ".kiln"), { recursive: true, force: true });
  return git(repo, ["remote"]).stdout.trim() === "" && !existsSync(join(repo, ".kiln"));
}

function setupRows(repo) {
  // First, and on its own line: the array literal below evaluates its consts before its
  // elements, so a `detach` call sitting in the list ran after `init` and deleted what
  // init had just written.
  const safe = detach(repo);
  const proposed = kiln(repo, ["init", "--propose"]);
  const plan = proposed.status === 0 ? JSON.parse(proposed.stdout) : null;
  const stackArg = plan && plan.detected.stack.id === "unknown" ? ["--set", "stack.id=node"] : [];
  const init = kiln(repo, ["init", ...stackArg, "--set", "stack.cmd.test=node --version"]);
  runnableSteps(repo);
  const doctor = kiln(repo, ["doctor"]);
  return [
    { id: "safety", ok: safe, detail: "origin removed and any earlier .kiln cleared; no upstream is reachable" },
    { id: "J1.1 detect", ok: Boolean(plan), detail: plan ? `${plan.detected.stack.id} (${plan.detected.stack.evidence ?? "no manifest kiln reads"})` : proposed.stderr.trim() },
    { id: "J1.1 branch", ok: Boolean(plan), detail: plan ? `ships to ${plan.config.vcs.integration_branch}` : "-" },
    { id: "J9.5 asks", ok: Boolean(plan), detail: plan ? plan.questions.map((q) => q.key).join(" ") : "-" },
    { id: "J1.1 init", ok: init.status === 0, detail: init.status === 0 ? "config, rules, floor written" : init.stderr.trim().split("\n")[0] },
    floorRowFor(repo),
    { id: "J1.4 doctor", ok: doctor.status === 0, detail: doctor.status === 0 ? "Ready" : firstFail(doctor.stdout) },
  ];
}

/**
 * Asked of kiln rather than guessed from a path: on a project that sets `core.hooksPath`,
 * `.git/hooks/pre-push` is the wrong place to look, and looking there is how the absent
 * floor went unnoticed on every husky repository.
 */
function floorRowFor(repo) {
  const doctor = kiln(repo, ["doctor"]).stdout;
  const line = (doctor.split("\n").find((row) => row.includes("push floor")) ?? "").trim();
  return { id: "J8.8 floor", ok: line.includes("[ ok ]") || line.includes("will not replace"), detail: line.replace(/^\[[^\]]+\]\s*/, "") };
}

function rows(repo) {
  return [...setupRows(repo), ...workRows(repo), ...guardRows(repo), ...floorRow(repo)];
}

function firstFail(text) {
  return (text.split("\n").find((line) => line.includes("[FAIL]")) ?? text.split("\n")[0] ?? "").trim();
}

function workRows(repo) {
  const id = "acceptance-1";
  const source = sourceFile(repo);
  const out = [
    { id: "J2.1 open", ok: kiln(repo, ["open", id, "--session", SESSION]).status === 0, detail: "work opened on bounded" },
    { id: "J2.2 gate shut", ok: edit(repo, source) === 2, detail: "a source edit before the plan gate is blocked" },
  ];

  mkdirSync(join(repo, ".kiln", "work", id), { recursive: true });
  writeFileSync(join(repo, ".kiln", "work", id, "plan.md"), "# plan\n", "utf8");
  const gate = kiln(repo, ["gate", id, "plan", "--artifact", `.kiln/work/${id}/plan.md`, "--answer", "1. Approve this plan as written", "--predicted", source]);
  out.push({ id: "J3.2 gate", ok: gate.status === 0, detail: "a menu label is read as the answer" });
  out.push({ id: "J2.1 open gate", ok: edit(repo, source) === 0, detail: "and the gate authorises the edit it named" });

  writeFileSync(join(repo, source), `${readFileSync(join(repo, source), "utf8")}\n`, "utf8");
  return [...out, ...afterEditRows(repo, id)];
}

function afterEditRows(repo, id) {
  const scope = kiln(repo, ["scope", id]);
  const green = kiln(repo, ["verify", id]);
  const ship = kiln(repo, ["ship", id]);
  return [
    { id: "J9.6 scope", ok: scope.stdout.includes("actual 1"), detail: scope.stdout.split("\n")[0]?.trim() ?? "" },
    { id: "J6.1 verify", ok: green.status === 0 && green.stdout.includes("green"), detail: green.stdout.trim().split("\n").pop() ?? "" },
    { id: "J6.1 report", ok: kiln(repo, ["report", id]).stdout.includes("green"), detail: "the report agrees with the verdict" },
    { id: "J9.6 ship", ok: ship.stdout.includes("Ship — 1 repository"), detail: ship.stdout.split("\n")[0]?.trim() ?? "" },
    { id: "J5.1 auto off", ok: kiln(repo, ["gate", id, "review", "--auto"]).status === 2, detail: "auto is off, so it refuses and says ask the user" },
    { id: "J6.3 skip", ok: skipRefuses(repo, id), detail: "a phase where every step is skipped refuses" },
    redRow(repo, id),
    ...rulesRows(repo, id),
  ];
}

function routerIndex(trigger, file) {
  return `| Trigger | Rule file |\n|---|---|\n| ${trigger} |${file ? ` ${file} |` : ""}\n`;
}

function doctorLine(repo, title) {
  const found = kiln(repo, ["doctor"]).stdout.split("\n").find((line) => line.includes(title));
  return (found ?? "").trim();
}

/**
 * The router, on a checkout somebody else laid out. The trigger is written against a file
 * this project actually has, so a match here is a match on real paths — a fixture can
 * always be built to match itself.
 */
function rulesRows(repo, id) {
  const source = sourceFile(repo);
  const dir = join(repo, ".kiln", "rules");
  writeFileSync(join(dir, "house.md"), "Never commit a secret.\n", "utf8");
  writeFileSync(join(dir, "index.md"), routerIndex(source, "house.md"), "utf8");

  const out = [
    { id: "R1 resolved", ok: doctorLine(repo, "rules routing").includes("all resolved"), detail: doctorLine(repo, "rules routing") },
    { id: "R2 plan", ok: kiln(repo, ["rules", id, "--stage", "plan"]).stdout.includes("Never commit a secret."), detail: `${source} routed to house.md, matched against the plan` },
    { id: "R3 review", ok: kiln(repo, ["rules", id, "--stage", "review"]).stdout.includes("Never commit a secret."), detail: "and against the diff the run actually produced" },
    { id: "R4 recorded", ok: rulesRecorded(repo, id), detail: "state.rules names both stages, so the reading is a fact rather than a hope" },
    { id: "R5 guarded", ok: edit(repo, ".kiln/rules/house.md") === 2, detail: "a run may not rewrite the rule it is judged by" },
    ...routerFaults(repo, source),
  ];
  writeFileSync(join(dir, "index.md"), routerIndex(source, "house.md"), "utf8");
  return out;
}

function rulesRecorded(repo, id) {
  const path = join(repo, ".kiln", "work", id, "state.json");
  const stages = (JSON.parse(readFileSync(path, "utf8")).rules ?? []).map((row) => row.stage);
  return stages.includes("plan") && stages.includes("review");
}

/** The failure Cursor ships silently: a row that cannot resolve, skipped with no symptom. */
function routerFaults(repo, source) {
  const index = join(repo, ".kiln", "rules", "index.md");
  writeFileSync(index, routerIndex(source, ""), "utf8");
  const half = kiln(repo, ["doctor"]);

  writeFileSync(index, routerIndex("no/such/path/**", "house.md"), "utf8");
  const dead = doctorLine(repo, "rules routing");

  return [
    { id: "R6 half row", ok: half.status === 1 && half.stdout.includes("one of the two columns"), detail: "a row filling one column of two is a FAIL, not a silent skip" },
    { id: "R7 dead route", ok: dead.includes("matches no file here"), detail: dead },
  ];
}

/**
 * These projects are cloned, not installed, so their real `lint` and `typecheck` binaries
 * are absent. `init` writes the steps the project declares, and on prettier and vitest the
 * first run therefore reported `exit 127` and refused to call it green — which is kiln
 * being right, not kiln failing. Every command a step names is pointed at something that
 * runs offline, and the failing case is asserted deliberately below instead of by accident.
 */
function runnableSteps(repo) {
  const path = join(repo, ".kiln", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const keys = (config.stack.steps ?? []).flatMap((step) => [...String(step.run).matchAll(/\$\{cmd\.(\w+)\}/g)].map((m) => m[1]));
  const cmd = Object.fromEntries(keys.map((key) => [key, "node --version"]));
  writeFileSync(path, JSON.stringify({ ...config, stack: { ...config.stack, cmd: { ...config.stack.cmd, ...cmd } } }, null, 2), "utf8");
  return keys;
}

function withCmd(repo, { key, value }) {
  const path = join(repo, ".kiln", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const before = config.stack.cmd[key];
  writeFileSync(path, JSON.stringify({ ...config, stack: { ...config.stack, cmd: { ...config.stack.cmd, [key]: value } } }, null, 2), "utf8");
  return () => withCmd(repo, { key, value: before });
}

function skipRefuses(repo, id) {
  const path = join(repo, ".kiln", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...config, stack: { ...config.stack, steps: [{ id: "unit", run: "${cmd.test}", requires: ["migrate"] }] } }, null, 2), "utf8");
  const run = kiln(repo, ["verify", id]);
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return run.status === 1 && run.stderr.includes("every step was skipped");
}

/** A step that lies about itself: the verdict is the exit code, never the words. */
function redRow(repo, id) {
  const restore = withCmd(repo, { key: "test", value: "echo All tests passed && exit 1" });
  const run = kiln(repo, ["verify", id]);
  restore();
  return {
    id: "J6.2 red",
    ok: run.status === 1 && !run.stdout.includes("green") && run.stderr.includes("All tests passed"),
    detail: "a test that prints a pass and exits 1 is a failure",
  };
}

/**
 * Whether this checkout stands on a protected branch is a property of the layout, not an
 * assumption. A linked worktree is on a branch of its own by definition — express checked
 * out at `wt-branch` while `vcs.protected` says `master` — and asserting a block there was
 * asserting that kiln blocks a legitimate push.
 *
 * So the expectation follows the config, and the branch is then protected and the same
 * push tried again: both directions are checked on every layout, which is the only way a
 * false block and a missing block are told apart.
 */
function branchStanding(repo) {
  const config = JSON.parse(readFileSync(join(repo, ".kiln", "config.json"), "utf8"));
  const branch = git(repo, ["symbolic-ref", "--short", "HEAD"]).stdout.trim();
  return { branch, protectedHere: config.vcs.protected.includes(branch) };
}

function protectCurrentBranch(repo) {
  const { branch, protectedHere } = branchStanding(repo);
  if (protectedHere) return () => {};
  const config = JSON.parse(readFileSync(join(repo, ".kiln", "config.json"), "utf8"));
  const path = join(repo, ".kiln", "config.json");
  const before = readFileSync(path, "utf8");
  const vcs = { ...config.vcs, protected: [...config.vcs.protected, branch] };
  writeFileSync(path, JSON.stringify({ ...config, vcs }, null, 2), "utf8");
  return () => writeFileSync(path, before, "utf8");
}

function pushRows(repo) {
  const { branch, protectedHere } = branchStanding(repo);
  const want = protectedHere ? 2 : 0;
  return [
    ["J8.1 HEAD", "git push origin HEAD"],
    ["J8.1 named", `git push origin ${branch}`],
    ["J8.1 force", "git push --force origin +HEAD"],
  ].map(([id, command]) => ({
    id,
    ok: bash(repo, command) === want,
    detail: protectedHere ? command : `${command} — allowed: ${branch} is not protected here`,
  }));
}

function guardRows(repo) {
  const always = [
    ["J8.2 rm", "rm -rf /tmp/not-my-repo"],
    ["J8.7 config", "rm -f .kiln/config.json"],
    ["J8.7 hook", "rm -f .git/hooks/pre-push"],
    ["J8.7 verify", "git push --no-verify origin HEAD"],
    ["J8.7 hooksPath", "git config core.hooksPath /dev/null"],
  ].map(([id, command]) => ({ id, ok: bash(repo, command) === 2, detail: command }));

  return [...pushRows(repo), ...always, onceProtected(repo), { id: "J8 narrow", ok: bash(repo, "rm -f build/out.log") === 0, detail: "an ordinary file is still the harness's call" }];
}

/** The other direction: protect the branch this checkout is on, and the same push must stop. */
function onceProtected(repo) {
  const restore = protectCurrentBranch(repo);
  const verdict = bash(repo, "git push origin HEAD");
  restore();
  return { id: "J8.1 both ways", ok: verdict === 2, detail: "protecting the branch this checkout stands on blocks the same push" };
}

/**
 * D90 refuses to replace a hook the project already owns, so on such a repository the floor
 * is genuinely absent and git lets the push through. That is the documented limit, not a
 * defect — and the layer that still holds is the PreToolUse guard, which the rows above
 * exercised. So the expectation follows what kiln said about the floor rather than assuming
 * it is always there.
 */
function floorRow(repo) {
  const owned = kiln(repo, ["doctor"]).stdout.includes("will not replace it");
  const remote = mkdtempSync(join(tmpdir(), "kiln-acc-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(repo, ["remote", "add", "origin", remote]);
  const restore = protectCurrentBranch(repo);
  const push = git(repo, ["push", "origin", "HEAD"]);
  restore();
  rmSync(remote, { recursive: true, force: true });

  const refused = push.status !== 0 && /is a protected branch/.test(push.stderr);
  return [owned
    ? { id: "J8.8 limit", ok: !refused, detail: "the project owns pre-push, so kiln did not take it — a stated limit, and the guard above still blocks" }
    : { id: "J8.8 real push", ok: refused, detail: (push.stderr.split("\n").find((line) => line.includes("protected")) ?? push.stderr.split("\n")[0] ?? "").trim() }];
}

/**
 * A regular file at the root, a README first. Four spellings was a guess, and express ships
 * `Readme.md`, so the harness crashed reading a file that was not there.
 *
 * Not a symlink, either: zod's `README.md` points into `packages/`, and kiln refuses to
 * follow one (D52). A row asserting that the gate authorises this edit would have been
 * asserting that kiln does the unsafe thing.
 */
function sourceFile(repo) {
  const entries = readdirSync(repo).filter((name) => !name.startsWith("."));
  const regular = (name) => lstatSync(join(repo, name)).isFile();
  return entries.filter((name) => /^readme/i.test(name)).find(regular)
    ?? entries.filter((name) => /\.(md|txt|rst)$/i.test(name)).find(regular)
    ?? entries.find(regular)
    ?? "README.md";
}

const say = (line) => process.stdout.write(`${line}\n`);

function report(repo, results) {
  const failed = results.filter((row) => !row.ok);
  say(`\n── ${basename(repo)} ${"─".repeat(Math.max(2, 58 - basename(repo).length))}`);
  for (const row of results) say(`  ${row.ok ? "ok  " : "FAIL"}  ${row.id.padEnd(16)} ${row.detail}`);
  say(`  ${failed.length === 0 ? "all rows passed" : `${failed.length} FAILED`}`);
  return failed.length;
}

const repos = process.argv.slice(2);
if (repos.length === 0) {
  console.error("usage: node scripts/acceptance-journey.mjs <repo> [<repo> ...]");
  process.exit(1);
}
const failures = repos.reduce((sum, repo) => sum + report(repo, rows(repo)), 0);
say(`\n${failures === 0 ? "every repository passed every row." : `${failures} row(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
