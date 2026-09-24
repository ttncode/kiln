import { execFileSync } from "node:child_process";
import { repositories, scanProject, treeAt } from "./scan.mjs";

/**
 * How far the code has moved from what the store describes (D22), measured against the ledger
 * rather than a commit range: a file whose blob changed since it was read has drifted, whatever
 * route it took there. The integration branch is fetched first, and a failed fetch is reported,
 * never counted as no drift (D82).
 */

/** D22's "small drift": at or under this many files, catching up is offered with yes as the default. */
export const SMALL_DRIFT = 20;

const FETCH_TIMEOUT_MS = 30_000;

/** A fetch that would stop to ask for a password is a failed fetch, not a hung check. */
function fetchIntegration(repo) {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", repo.branch], { cwd: repo.dir, stdio: ["ignore", "ignore", "pipe"], timeout: FETCH_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return null;
  } catch (error) {
    if (error.code === "ETIMEDOUT") return `${repo.name}: git fetch origin ${repo.branch} timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
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
 * The blob each path had at the repository's pin, or null for a repository never pinned. A
 * candidate the ledger lacks is drift only if it is new or different since the pin; one that sat
 * there unchanged is the bootstrap's unfinished work, not the code moving.
 */
function pinnedTrees(repos, pins) {
  return new Map(repos.map((repo) => [repo.name, pins[repo.name] ? treeAt({ ...repo, commit: pins[repo.name] }) : null]));
}

/**
 * Fetches, then measures. `unfetched` names each repository whose fetch failed; its numbers are
 * then as old as the last fetch, and the caller must say so.
 */
export function measureDrift(root, { config, store }) {
  const unfetched = repositories(root, config).filter(hasOrigin).map(fetchIntegration).filter(Boolean);
  const { repos: read, files } = scanProject(root, { config, ledger: store.scanned });
  const pinned = pinnedTrees(read, store.manifest?.source_pins ?? {});
  const present = new Set(files.map((file) => file.path));
  const changed = files.filter((file) => store.scanned[file.path] && store.scanned[file.path] !== file.blob);
  const unscanned = files.filter((file) => file.class === "CANDIDATE" && !store.scanned[file.path]);
  const movedSincePin = (file) => pinned.get(file.repo) && pinned.get(file.repo).get(file.path) !== file.blob;
  const deleted = Object.keys(store.scanned).filter((path) => !present.has(path));
  return { repos: read, files, changed, added: unscanned.filter(movedSincePin), unread: unscanned.filter((file) => !movedSincePin(file)), deleted, unfetched };
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
