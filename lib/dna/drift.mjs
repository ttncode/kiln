import { execFileSync } from "node:child_process";
import { repositories, scanProject } from "./scan.mjs";

/**
 * How far the code has moved from what the store describes (D22), measured against the ledger
 * rather than a commit range: a file whose blob changed since it was read has drifted, whatever
 * route it took there. The integration branch is fetched first, and a failed fetch is reported,
 * never counted as no drift (D82).
 */

/** D22's "small drift": at or under this many files, catching up is offered with yes as the default. */
export const SMALL_DRIFT = 20;

function fetchIntegration(repo) {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", repo.branch], { cwd: repo.dir, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
    return null;
  } catch (error) {
    const said = String(error.stderr ?? "").trim().split("\n").at(-1);
    return `${repo.name}: git fetch origin ${repo.branch} failed${said ? ` (${said})` : ""}`;
  }
}

function hasOrigin(repo) {
  try {
    execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo.dir, stdio: "ignore" });
    return true;
  } catch {
    // No remote named origin: a local-only project, where there is nothing to fetch.
    return false;
  }
}

/**
 * Fetches, then measures. `unfetched` names each repository whose fetch failed; its numbers are
 * then as old as the last fetch, and the caller must say so.
 */
export function measureDrift(root, { config, store }) {
  const unfetched = repositories(root, config).filter(hasOrigin).map(fetchIntegration).filter(Boolean);
  const { repos: read, files } = scanProject(root, { config, ledger: store.scanned });
  const present = new Set(files.map((file) => file.path));
  const changed = files.filter((file) => store.scanned[file.path] && store.scanned[file.path] !== file.blob);
  const added = files.filter((file) => file.class === "CANDIDATE" && !store.scanned[file.path]);
  const deleted = Object.keys(store.scanned).filter((path) => !present.has(path));
  return { repos: read, files, changed, added, deleted, unfetched };
}

/** The findings that cite a path as their module: what a change or a deletion puts in doubt. */
export function citing(findings, paths) {
  const wanted = new Set(paths);
  return findings.filter((finding) => wanted.has(finding.module));
}

/** D22's three answers, and D82's fourth: a failed fetch makes the whole store low-confidence. */
export function driftVerdict({ changed, added, deleted, unfetched }) {
  const size = changed.length + added.length + deleted.length;
  if (unfetched.length > 0) return { level: "unknown", size };
  if (size === 0) return { level: "none", size };
  return { level: size <= SMALL_DRIFT ? "small" : "large", size };
}
