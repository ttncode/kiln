import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const created = [];

export function tempRoot(prefix = "kiln-fx-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupFixtures() {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true });
}

export function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

export function writeConfig(root, config) {
  return writeFile(join(root, ".kiln", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function initRepo(root) {
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  return root;
}

/**
 * The identity is passed per command rather than assumed: a submodule checkout inside a
 * fixture is a repository nothing ran `initRepo` on, and CI runners carry no global one,
 * so `git commit` there fails with "empty ident name".
 */
export function commitAll(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "--quiet", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
