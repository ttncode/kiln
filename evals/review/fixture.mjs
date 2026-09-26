import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fixture is a repository at its base commit with the change left uncommitted, the way kiln
 * reviews a work: nothing is committed until SHIP (D142). The review inputs — diff, claims,
 * plan — sit beside the repository, not in it, so no reader mistakes them for the change.
 */

const GIT_IDENTITY = ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "-c", "commit.gpgsign=false"];

function git(repo, args) {
  return execFileSync("git", [...GIT_IDENTITY, ...args], { cwd: repo, encoding: "utf8" }).trim();
}

function read(dir, name) {
  return readFileSync(join(dir, name), "utf8");
}

function initRepository(fixture, repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  cpSync(join(fixture, "base"), repo, { recursive: true });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** New files are added as intent-to-add so `git diff` shows them, as a reviewer's `git status` would list them. */
function applyChange(fixture, repo) {
  cpSync(join(fixture, "change"), repo, { recursive: true });
  git(repo, ["add", "-A", "-N"]);
  return git(repo, ["diff", "HEAD"]);
}

export function materialize(fixture, work) {
  const repo = join(work, "repo");
  const inputs = join(work, "inputs");
  const base = initRepository(fixture, repo);
  mkdirSync(inputs, { recursive: true });
  writeFileSync(join(inputs, "diff.patch"), `${applyChange(fixture, repo)}\n`);
  for (const name of ["claims.md", "plan.md", "request.md"]) writeFileSync(join(inputs, name), read(fixture, name));
  return {
    repo,
    inputs,
    base,
    diffFile: join(inputs, "diff.patch"),
    claimsFile: join(inputs, "claims.md"),
    planFile: join(inputs, "plan.md"),
    request: read(fixture, "request.md").trim(),
    claims: read(fixture, "claims.md").trim(),
    plan: read(fixture, "plan.md").trim(),
  };
}

export function defectsOf(fixture) {
  return JSON.parse(read(fixture, "defects.json"));
}

export function isFixture(dir) {
  return ["base", "change", "defects.json"].every((name) => existsSync(join(dir, name)));
}
