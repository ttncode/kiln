import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../../hooks/dispatch.mjs";
import { DEFAULTS } from "../../lib/config.mjs";
import { commitAll, git, initRepo, tempRoot, writeConfig, writeFile } from "./fixture.mjs";

const BIN = new URL("../../bin/kiln.mjs", import.meta.url).pathname;

/** The real binary, in a real repository. Nothing here stubs the thing under test. */
export function kiln(root, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8" });
}

export function ok(root, args) {
  const run = kiln(root, args);
  if (run.status !== 0) throw new Error(`kiln ${args.join(" ")} exited ${run.status}\n${run.stdout}${run.stderr}`);
  return run;
}

export const SESSION = "journey-session";

export function edit(root, file, session = SESSION) {
  return dispatch("pre-edit", { session_id: session, cwd: root, tool_input: { file_path: join(root, file) } });
}

export function bash(root, command, session = SESSION) {
  return dispatch("pre-bash", { session_id: session, cwd: root, tool_input: { command } });
}

export function state(root, id) {
  return JSON.parse(readFileSync(join(root, ".kiln", "work", id, "state.json"), "utf8"));
}

export function config(root) {
  return JSON.parse(readFileSync(join(root, ".kiln", "config.json"), "utf8"));
}

/** A Node project a person would actually run `kiln init` in. */
export function nodeProject({ name = "journey", steps, cmd, auto } = {}) {
  const root = initRepo(tempRoot(`kiln-j-${name}-`));
  writeFile(join(root, "package.json"), JSON.stringify({ name, scripts: { test: "true" } }));
  writeFile(join(root, "src", "app.js"), "export const a = 1;\n");
  commitAll(root, "first");
  writeConfig(root, {
    ...DEFAULTS,
    ...(auto ? { auto } : {}),
    stack: { id: "node", cmd: cmd ?? { test: "true" }, steps: steps ?? [{ id: "unit", run: "${cmd.test}" }] },
  });
  writeFile(join(root, ".kiln", "rules", "index.md"), "# rules\n");
  return root;
}

/** A superproject whose source lives in submodules, on their own branches. */
export function monorepo({ modules = [["AdminPage", "AdminPage", "v3-master"]] } = {}) {
  const root = initRepo(tempRoot("kiln-j-mono-"));
  writeFile(join(root, "README.md"), "super\n");
  commitAll(root, "super");

  for (const [name, path, branch] of modules) {
    const sub = initRepo(tempRoot("kiln-j-sub-"));
    writeFile(join(sub, "composer.json"), JSON.stringify({ require: {} }));
    writeFile(join(sub, "src", "User.php"), "<?php\n");
    commitAll(sub, "sub");
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "--name", name, sub, path]);
    git(join(root, path), ["checkout", "-q", "-b", branch]);
  }
  commitAll(root, "add submodules");
  return root;
}

/** Walks a work to the point where source edits are allowed, the way a run does. */
export function throughPlanGate(root, id, { path = "bounded", predicted = "src/app.js", auto = false } = {}) {
  ok(root, ["open", id, "--path", path, "--session", SESSION, ...(auto ? ["--auto"] : [])]);
  writeFile(join(root, ".kiln", "work", id, "plan.md"), "# plan\n");
  const answer = auto ? ["--auto"] : ["--answer", "Approve this plan as written"];
  return ok(root, ["gate", id, "plan", "--artifact", `.kiln/work/${id}/plan.md`, ...answer, "--predicted", predicted]);
}
