import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { integrationBranch } from "../config.mjs";
import { modulesOf } from "../modules.mjs";
import { DnaError } from "./store.mjs";

/**
 * Phase 1 of the bootstrap playbook — "find what's worth reading" — made mechanical. Every
 * file of every repository at its integration branch is classed CANDIDATE, SHELL, TEST or
 * OTHER, and the candidates are ranked by how much branching they carry. The source asked each
 * project to write this script for itself; one generic ranking is what makes it a command.
 *
 * What was scanned is recorded by blob, not by name, so a file that changed since it was read
 * is unscanned again without anyone having to say so — the ledger is the playbook's
 * `ALREADY_SCANNED`, keyed the way `update`'s "diff, don't re-scan" needs it.
 */

const ROOT_REPO = "root";
const MAX_BYTES = 512 * 1024;
const MIN_BRANCHES = 2;
const BRANCH = /\b(?:if|elif|elsif|else\s+if|switch|case|when|for|foreach|while|catch|except|rescue|unless|match|guard)\b|&&|\|\|/g;
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|php|rb|go|java|kts?|cs|scala|rs|c|cc|cpp|h|hpp|swift|m|mm|sql|sh|bash|ex|exs|erl|clj|lua|dart|groovy|pl|pm)$/i;
const VENDORED = /(?:^|\/)(?:\.kiln|node_modules|vendor|bower_components|third_party|dist|build|out|coverage|\.next|\.nuxt|target|generated|__generated__)\//i;
const GENERATED = /(?:\.min\.[cm]?js|\.d\.ts|\.pb\.go|_pb2\.py|\.generated\.\w+|\.lock|-lock\.json)$/i;
const TEST = /(?:^|\/)(?:tests?|__tests__|specs?|e2e|fixtures?|__mocks__|testdata)\/|\.(?:test|spec)\.\w+$|_test\.\w+$|(?:^|\/)test_[^/]+\.py$/i;

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function tipOf(cwd, ref) {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim() || null;
}

/**
 * D80: the store is pinned only from the integration branch. `origin/<branch>` first — the
 * integration branch as merged, which is what D22 compares against — then the local branch
 * for a project with no remote. Anything else can be scanned but never pinned.
 */
export function scanRef(cwd, branch) {
  for (const ref of [`origin/${branch}`, branch]) {
    const commit = tipOf(cwd, ref);
    if (commit) return { ref, commit, pinnable: true };
  }
  const head = tipOf(cwd, "HEAD");
  if (!head) throw new DnaError(`${cwd} has no commit to scan.`);
  return { ref: "HEAD", commit: head, pinnable: false };
}

/** The repositories a store describes: the project, and every module checked out inside it. */
export function repositories(root, config) {
  const modules = Object.entries(modulesOf(config)).map(([name, path]) => ({ name, path, branch: integrationBranch(config, name) }));
  return [{ name: ROOT_REPO, path: "", branch: integrationBranch(config) }, ...modules].map((repo) => ({ ...repo, dir: join(root, repo.path), ...scanRef(join(root, repo.path), repo.branch) }));
}

function projectPath(repo, path) {
  return repo.path ? `${repo.path}/${path}` : path;
}

/** `git ls-tree -l`: blobs only, since a submodule is scanned as its own repository. */
export function filesAt(repo) {
  const listing = git(repo.dir, ["ls-tree", "-r", "-l", "-z", repo.commit]) ?? "";
  return listing.split("\0").filter(Boolean).map((line) => {
    const [meta, path] = line.split("\t");
    const [, type, blob, size] = meta.split(/\s+/);
    return { type, blob, size: Number(size), path: projectPath(repo, path), repo: repo.name };
  }).filter((file) => file.type === "blob");
}

/** The class a path alone decides, or null when only the content can. */
export function classByPath(file) {
  if (!CODE.test(file.path) || VENDORED.test(file.path) || GENERATED.test(file.path) || file.size > MAX_BYTES) return "OTHER";
  return TEST.test(file.path) ? "TEST" : null;
}

export function measure(text) {
  const lines = text.split("\n").filter((line) => line.trim()).length;
  const branches = (text.match(BRANCH) ?? []).length;
  return { lines, branches, density: lines > 0 ? branches / lines : 0 };
}

/** One `git cat-file --batch` for every blob, rather than a process per file. */
function contents(cwd, blobs) {
  if (blobs.length === 0) return new Map();
  const raw = execFileSync("git", ["cat-file", "--batch"], { cwd, input: `${blobs.join("\n")}\n`, maxBuffer: 1 << 30 });
  const found = new Map();
  let at = 0;
  while (at < raw.length) {
    const header = raw.subarray(at, raw.indexOf(10, at)).toString("utf8");
    const [blob, type, size] = header.split(" ");
    const start = raw.indexOf(10, at) + 1;
    if (type === "missing") {
      at = start;
      continue;
    }
    found.set(blob, raw.subarray(start, start + Number(size)).toString("utf8"));
    at = start + Number(size) + 1;
  }
  return found;
}

function classify(repo) {
  const files = filesAt(repo).map((file) => ({ ...file, class: classByPath(file) }));
  const text = contents(repo.dir, [...new Set(files.filter((file) => file.class === null).map((file) => file.blob))]);
  return files.map((file) => {
    if (file.class) return file;
    const measured = measure(text.get(file.blob) ?? "");
    return { ...file, ...measured, class: measured.branches >= MIN_BRANCHES ? "CANDIDATE" : "SHELL" };
  });
}

/**
 * Every file of every repository, classed, with `scanned` true when the ledger holds this
 * exact blob. Candidates come first, densest first.
 */
export function scanProject(root, { config, ledger }) {
  const repos = repositories(root, config);
  const files = repos.flatMap(classify).map((file) => ({ ...file, scanned: ledger[file.path] === file.blob }));
  const rank = (a, b) => b.density - a.density || b.branches - a.branches || (a.path < b.path ? -1 : 1);
  return { repos, files: [...files.filter((file) => file.class === "CANDIDATE").sort(rank), ...files.filter((file) => file.class !== "CANDIDATE")] };
}

/**
 * The blob each named file has at the commit a scan round read. A path the commit does not hold
 * is refused: the ledger may only say a file was read at a commit that has it.
 */
export function blobsAt(repo, paths) {
  const inRepo = paths.map((path) => (repo.path ? path.slice(repo.path.length + 1) : path));
  const listing = inRepo.length > 0 ? git(repo.dir, ["ls-tree", "-z", repo.commit, "--", ...inRepo]) ?? "" : "";
  const found = new Map(listing.split("\0").filter(Boolean).map((line) => [projectPath(repo, line.split("\t")[1]), line.split(/\s+/)[2]]));
  const missing = paths.filter((path) => !found.has(path));
  if (missing.length > 0) throw new DnaError(`${repo.name} at ${repo.commit.slice(0, 12)} has no ${missing.slice(0, 5).join(", ")}; a scan round can only record files its commit holds.`);
  return found;
}

const GROUP_LINES = 800;
const CHUNK_LINES = 400;

/** Files are never split across groups: a file one agent half-read is not a file scanned. */
export function groupFiles(files) {
  const groups = [];
  for (const file of files) {
    const last = groups.at(-1);
    if (last && last.lines + file.lines <= GROUP_LINES) {
      last.files.push(file);
      last.lines += file.lines;
    } else groups.push({ files: [file], lines: file.lines });
  }
  return groups.map((group) => group.files);
}

function chunksOf(lines) {
  if (lines <= CHUNK_LINES) return undefined;
  return Array.from({ length: Math.ceil(lines / CHUNK_LINES) }, (_, index) => [index * CHUNK_LINES + 1, Math.min(lines, (index + 1) * CHUNK_LINES)]);
}

/**
 * The same blob in the working tree means the agent reads the file where it is; anything else
 * — a feature branch checked out, a file edited since — means it reads the commit's copy,
 * written under `.kiln/tmp/dna/`, because a finding describes the commit the ledger records.
 */
function workingBlobs(repo, paths) {
  const inRepo = paths.map((path) => (repo.path ? path.slice(repo.path.length + 1) : path));
  const existing = inRepo.filter((path) => existsSync(join(repo.dir, path)));
  const hashes = existing.length > 0 ? execFileSync("git", ["hash-object", "--stdin-paths"], { cwd: repo.dir, input: `${existing.join("\n")}\n`, encoding: "utf8" }).trim().split("\n") : [];
  return new Map(existing.map((path, index) => [projectPath(repo, path), hashes[index]]));
}

function readPlaces(root, { repo, files }) {
  const working = workingBlobs(repo, files.map((file) => file.path));
  const stale = files.filter((file) => working.get(file.path) !== file.blob);
  const snapshot = join(root, ".kiln", "tmp", "dna", repo.commit.slice(0, 12));
  const text = contents(repo.dir, stale.map((file) => file.blob));
  for (const file of stale) {
    mkdirSync(dirname(join(snapshot, file.path)), { recursive: true });
    writeFileSync(join(snapshot, file.path), text.get(file.blob) ?? "");
  }
  return new Map(files.map((file) => [file.path, stale.includes(file) ? relative(root, join(snapshot, file.path)) : file.path]));
}

/** One batch skeleton per group: the files, the commit they were read at, and where to read them. */
export function skeletons(root, { repos, groups }) {
  return groups.map((files) => {
    const places = new Map(repos.flatMap((repo) => [...readPlaces(root, { repo, files: files.filter((file) => file.repo === repo.name) })]));
    const commits = Object.fromEntries(repos.filter((repo) => files.some((file) => file.repo === repo.name)).map((repo) => [repo.name, repo.commit]));
    return {
      read: files.map((file) => ({ path: file.path, at: places.get(file.path), lines: file.lines, chunks: chunksOf(file.lines) })),
      scan: { commits, files: files.map((file) => file.path) },
      upsert: { findings: [] },
    };
  });
}
