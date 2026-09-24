import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { integrationBranch } from "../config.mjs";
import { modulesOf } from "../modules.mjs";
import { isInside } from "../paths.mjs";
import { DnaError } from "./store.mjs";

/**
 * Phase 1 of the bootstrap playbook — "find what's worth reading" — made mechanical. Every
 * file of every repository at its integration branch is classed CANDIDATE, SHELL, TEST or
 * OTHER, and the candidates are ranked by how much branching they carry. The source asked each
 * project to write this script for itself; one generic ranking is what makes it a command.
 *
 * The ledger records the blob each path was read at, so a file whose content changed since is
 * unscanned again without anyone having to say so — the playbook's `ALREADY_SCANNED`, keyed the
 * way `update`'s "diff, don't re-scan" needs it.
 */

const ROOT_REPO = "root";
const MAX_BYTES = 512 * 1024;
const MIN_BRANCHES = 2;
const BRANCH = /\b(?:if|elif|elsif|else\s+if|switch|case|when|for|foreach|while|catch|except|rescue|unless|match|guard)\b|&&|\|\|/g;
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|php|rb|go|java|kts?|cs|scala|rs|c|cc|cpp|h|hpp|swift|m|mm|sql|sh|bash|ex|exs|erl|clj|lua|dart|groovy|pl|pm)$/i;
const KILN_DIR = /(?:^|\/)\.kiln\//;
const VENDORED = /(?:^|\/)(?:node_modules|vendor|bower_components|third_party|dist|build|out|coverage|\.next|\.nuxt|target|generated|__generated__)\//i;
const GENERATED = /(?:[.-]min\.[cm]?js|\.d\.ts|\.pb\.go|_pb2\.py|\.generated\.\w+|\.lock|-lock\.json)$/i;
const TEST = /(?:^|\/)(?:tests?|__tests__|specs?|e2e|fixtures?|__mocks__|testdata)\/|\.(?:test|spec)\.\w+$|_test\.\w+$|(?:^|\/)test_[^/]+\.py$/i;

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // The callers treat an absent answer as "no such ref" or "no such path" and say so.
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

/**
 * git run in a directory that is not a checkout answers for the repository above it, so a
 * module that was never initialised would be scanned — and pinned — as its parent.
 */
function checkedOut(dir, name) {
  const top = existsSync(dir) ? git(dir, ["rev-parse", "--show-toplevel"])?.trim() : null;
  if (top && realpathSync(top) === realpathSync(dir)) return;
  throw new DnaError(`module ${name} (${dir}) is not a checkout of its own. Initialise it (git submodule update --init) or remove it from repo.modules.`);
}

/** The repositories a store describes: the project, and every module checked out inside it. */
export function repositories(root, config) {
  const modules = Object.entries(modulesOf(config)).map(([name, path]) => ({ name, path, branch: integrationBranch(config, name) }));
  for (const module of modules) checkedOut(join(root, module.path), module.name);
  return [{ name: ROOT_REPO, path: "", branch: integrationBranch(config) }, ...modules].map((repo) => ({ ...repo, dir: join(root, repo.path), ...scanRef(join(root, repo.path), repo.branch) }));
}

function projectPath(repo, path) {
  return repo.path ? `${repo.path}/${path}` : path;
}

/** A tree can carry names a checkout refuses; none of them is a file kiln will read or write. */
function isSafePath(path) {
  return !path.startsWith("/") && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git");
}

/** One `ls-tree -z` record: `<mode> <type> <blob> <size>\t<name>`, where the name may hold a tab. */
function treeEntry(line) {
  const tab = line.indexOf("\t");
  const [, type, blob, size] = line.slice(0, tab).split(/\s+/);
  return { type, blob, size: Number(size), name: line.slice(tab + 1) };
}

/** Blobs only: a submodule is scanned as its own repository. */
export function filesAt(repo) {
  const listing = git(repo.dir, ["ls-tree", "-r", "-l", "-z", repo.commit]) ?? "";
  return listing.split("\0").filter(Boolean).map(treeEntry)
    .filter((entry) => entry.type === "blob" && isSafePath(entry.name))
    .map((entry) => ({ blob: entry.blob, size: entry.size, path: projectPath(repo, entry.name), repo: repo.name }));
}

const LINGUIST = { "linguist-vendored": "vendored", "linguist-generated": "generated" };

/** Linguist's `boolean_attribute`: any value but `false` is true; an unspecified one is no answer. */
function attributeValue(value) {
  if (value === "unspecified") return undefined;
  return value !== "unset" && value !== "false";
}

/**
 * D170: GitHub Linguist's overrides, answered by git itself. A path marked `linguist-vendored`
 * or `linguist-generated` (any value but `false`) is left out; `-linguist-vendored` keeps one the
 * built-in patterns would drop. Read from the checkout — `.gitattributes` or the never-committed `.git/info/attributes`
 * — not the scanned commit, so a line added locally takes effect at once.
 */
export function linguistMarks(cwd, names) {
  const marks = new Map();
  if (names.length === 0) return marks;
  const raw = execFileSync("git", ["check-attr", "-z", "--stdin", ...Object.keys(LINGUIST)], { cwd, input: `${names.join("\0")}\0`, encoding: "utf8", maxBuffer: 1 << 30 });
  const fields = raw.split("\0");
  for (let at = 0; at + 2 < fields.length; at += 3) {
    const [name, attribute, value] = fields.slice(at, at + 3);
    marks.set(name, { ...marks.get(name), [LINGUIST[attribute]]: attributeValue(value) });
  }
  return marks;
}

/** Third-party or generated code, by the checkout's attributes first and the built-in patterns after. */
export function isExcluded(file) {
  if (!CODE.test(file.path)) return false;
  return (file.vendored ?? VENDORED.test(file.path)) || (file.generated ?? GENERATED.test(file.path));
}

/** The class a path alone decides, or null when only the content can. */
export function classByPath(file) {
  if (!CODE.test(file.path) || KILN_DIR.test(file.path) || isExcluded(file) || file.size > MAX_BYTES) return "OTHER";
  return TEST.test(file.path) ? "TEST" : null;
}

/** Density reads code lines; `total` is the file's own line count, which is what a range cites. */
export function measure(text) {
  const all = text.split("\n");
  const total = text.endsWith("\n") ? all.length - 1 : all.length;
  const lines = all.filter((line) => line.trim()).length;
  const branches = (text.match(BRANCH) ?? []).length;
  return { lines, total, branches, density: lines > 0 ? branches / lines : 0 };
}

/** One `git cat-file --batch` for every blob, as bytes: a snapshot must be the blob, not a decoding of it. */
export function contents(cwd, blobs) {
  if (blobs.length === 0) return new Map();
  const raw = execFileSync("git", ["cat-file", "--batch"], { cwd, input: `${blobs.join("\n")}\n`, maxBuffer: 1 << 30 });
  const found = new Map();
  let at = 0;
  while (at < raw.length) {
    const start = raw.indexOf(10, at) + 1;
    const [blob, type, size] = raw.subarray(at, start - 1).toString("utf8").split(" ");
    if (type === "missing") {
      at = start;
      continue;
    }
    found.set(blob, raw.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return found;
}

function withLinguist(repo, files) {
  const name = (file) => (repo.path ? file.path.slice(repo.path.length + 1) : file.path);
  const marks = linguistMarks(repo.dir, files.filter((file) => CODE.test(file.path)).map(name));
  return files.map((file) => ({ ...file, ...marks.get(name(file)) }));
}

function classify(repo) {
  const files = withLinguist(repo, filesAt(repo)).map((file) => ({ ...file, class: classByPath(file) }));
  const bytes = contents(repo.dir, [...new Set(files.filter((file) => file.class === null).map((file) => file.blob))]);
  return files.map((file) => {
    if (file.class) return file;
    const measured = measure(bytes.get(file.blob)?.toString("utf8") ?? "");
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
 * The blob of every file a repository's commit holds — what a scan round's files are recorded
 * at, and what tells the ledger which of its paths no longer exist.
 */
export function treeAt(repo) {
  return new Map(filesAt(repo).map((file) => [file.path, file.blob]));
}

const GROUP_LINES = 800;
const CHUNK_LINES = 400;

/** Files are never split across groups: a file one agent half-read is not a file scanned. */
export function groupFiles(files) {
  const groups = [];
  for (const file of files) {
    const last = groups.at(-1);
    if (last && last.lines + file.total <= GROUP_LINES) {
      last.files.push(file);
      last.lines += file.total;
    } else groups.push({ files: [file], lines: file.total });
  }
  return groups.map((group) => group.files);
}

function chunksOf(total) {
  if (total <= CHUNK_LINES) return undefined;
  return Array.from({ length: Math.ceil(total / CHUNK_LINES) }, (_, index) => [index * CHUNK_LINES + 1, Math.min(total, (index + 1) * CHUNK_LINES)]);
}

/** git's blob id for a working file, computed here so no file name has to pass through a pipe. */
export function workingBlob(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * The same blob in the working tree means the agent reads the file where it is; anything else
 * — a feature branch checked out, a file edited since, a line-ending filter — means it reads the
 * commit's copy under `.kiln/tmp/dna/`, because a finding describes the commit the ledger records.
 */
function readPlaces(root, { repo, files }) {
  const stale = files.filter((file) => workingBlob(join(root, file.path)) !== file.blob);
  const snapshot = join(root, ".kiln", "tmp", "dna", repo.commit.slice(0, 12));
  const bytes = contents(repo.dir, stale.map((file) => file.blob));
  for (const file of stale) {
    const target = join(snapshot, file.path);
    if (!isInside(snapshot, target)) throw new DnaError(`${file.path} would be written outside ${snapshot}.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes.get(file.blob) ?? "");
  }
  return new Map(files.map((file) => [file.path, stale.includes(file) ? relative(root, join(snapshot, file.path)) : file.path]));
}

/**
 * Where git knows the file: a module's commit and blobs live in the module's own repository,
 * under its own path, so a `git diff` run with the project path from the project root fails.
 */
function inRepository(repos, file) {
  const repo = repos.find((each) => each.name === file.repo);
  return { repo: repo.path || ".", src: repo.name, ref: repo.path ? file.path.slice(repo.path.length + 1) : file.path, commit: repo.commit };
}

/** One batch skeleton per group: the files, the commit they were read at, where to read them, and when the round was written out (D177). */
export function skeletons(root, { repos, groups }) {
  const started = Math.floor(Date.now() / 1000);
  return groups.map((files) => {
    const places = new Map(repos.flatMap((repo) => [...readPlaces(root, { repo, files: files.filter((file) => file.repo === repo.name) })]));
    const commits = Object.fromEntries(repos.filter((repo) => files.some((file) => file.repo === repo.name)).map((repo) => [repo.name, repo.commit]));
    return {
      read: files.map((file) => ({ path: file.path, at: places.get(file.path), lines: file.total, chunks: chunksOf(file.total), ...inRepository(repos, file) })),
      scan: { commits, files: files.map((file) => file.path), started },
      upsert: { findings: [] },
    };
  });
}
