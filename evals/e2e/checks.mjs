import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What a user would look at after the run, read from the repository and from kiln's own record —
 * never from what the assistant said about itself.
 */

function git(repo, args) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The work the ticket opened: the newest state.json under .kiln/work. */
export function latestWork(repo) {
  const root = join(repo, ".kiln", "work");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((name) => existsSync(join(root, name, "state.json")));
  const newest = dirs.sort((a, b) => statSync(join(root, b, "state.json")).mtimeMs - statSync(join(root, a, "state.json")).mtimeMs)[0];
  return newest ? { dir: join(root, newest), state: JSON.parse(readFileSync(join(root, newest, "state.json"), "utf8")) } : null;
}

function lensesAccounted(work) {
  const review = (work.state.practices ?? []).find((row) => row.stage === "review")?.ids ?? [];
  const line = (/^lenses:\s*([\s\S]*?)(?:\n\s*\n|$(?![\s\S]))/im.exec(readIf(join(work.dir, "review.md")))?.[1] ?? "").replace(/\s+/g, " ");
  return { review, missing: review.filter((id) => !new RegExp(`(?<![\\w-])${id}\\s+(?:reported|failed)`).test(line)) };
}

function sourceChanged(repo, base) {
  return git(repo, ["diff", "--name-only", base, "--", ".", ":(exclude).kiln"]) + git(repo, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).kiln"]);
}

function check(name, { ok, detail }) {
  return { name, ok: Boolean(ok), detail };
}

function riskFlagsSection(work) {
  return /^## Risk flags[\s\S]*?(?=^## |$(?![\s\S]))/im.exec(readIf(join(work.dir, "plan.md")))?.[0] ?? "";
}

function flagChecks(work, expect) {
  const flags = riskFlagsSection(work);
  return (expect.flags ?? []).map((flag) => check(`plan flags ${flag}`, { ok: new RegExp(`^[-*]\\s*${flag}`, "im").test(flags), detail: flags.trim().split("\n").slice(1).join(" | ") }));
}

function reviewChecks(work, expect) {
  const lenses = lensesAccounted(work);
  return [
    check("review.md accounts for every reader kiln named", { ok: lenses.review.length > 0 && lenses.missing.length === 0, detail: `named ${lenses.review.join(", ") || "none"}; missing ${lenses.missing.join(", ") || "none"}` }),
    ...(expect.readers ?? []).map((reader) => check(`review ran ${reader}`, { ok: lenses.review.includes(reader), detail: lenses.review.join(", ") })),
    check("review gate approved", { ok: work.state.gates?.review?.decision === "approved", detail: JSON.stringify(work.state.gates?.review ?? null) }),
  ];
}

function workChecks(repo, { work, expect }) {
  const stages = (work.state.practices ?? []).map((row) => row.stage);
  const results = [check("kiln practices ran at each stage it reached", { ok: stages.length > 0, detail: stages.join(", ") || "none" })];
  if (expect.path) results.push(check(`path is ${expect.path}`, { ok: work.state.path === expect.path, detail: work.state.path }));
  return [...results, ...flagChecks(work, expect), ...(expect.ships ? reviewChecks(work, expect) : [])];
}

function shipChecks(repo, { base, expect }) {
  if (!expect.ships) return [];
  const commits = git(repo, ["log", "--all", "--oneline", `${base}..`, "--not", "main"]);
  return [check("the change is committed on a branch other than main", { ok: commits !== "", detail: commits || "no commit" })];
}

function suiteChecks(repo, expect) {
  if (!expect.tests_pass) return [];
  const run = spawnSync(process.execPath, ["--test"], { cwd: repo, encoding: "utf8" });
  return [check("the project's suite passes", { ok: run.status === 0, detail: (run.stdout.match(/# (pass|fail) \d+/g) ?? []).join(" ") })];
}

function repoChecks(repo, { work, expect }) {
  const base = work?.state.base ?? git(repo, ["rev-list", "--max-parents=0", "HEAD"]);
  const untouched = expect.no_source_change ? [check("no source file changed", { ok: sourceChanged(repo, base) === "", detail: sourceChanged(repo, base) || "clean" })] : [];
  const greps = Object.entries(expect.grep ?? {}).map(([file, pattern]) => check(`${file} mentions ${pattern}`, { ok: new RegExp(pattern, "i").test(readIf(join(repo, file))), detail: "" }));
  return [...untouched, ...shipChecks(repo, { base, expect }), ...suiteChecks(repo, expect), ...greps];
}

export function scenarioChecks(repo, { expect, toolUses }) {
  const work = latestWork(repo);
  const opened = check("a work was opened", { ok: work !== null, detail: work ? `${work.state.id} · ${work.state.path} · ${work.state.status}` : "none" });
  const dispatched = toolUses.filter((use) => use.name === "Task" || use.name === "Agent").length;
  const subagents = check("subagents dispatched (review readers and others)", { ok: !expect.ships || dispatched >= 3, detail: String(dispatched) });
  return [opened, subagents, ...(work ? workChecks(repo, { work, expect }) : []), ...repoChecks(repo, { work, expect })];
}
