import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/**
 * D186: files kiln copies from superpowers, agent-skills and BMAD. Each opens with a kiln note —
 * a block of `>` lines beginning `> **In kiln:**`, then one blank line — above the source's text.
 * `skills/copies.json` records where each came from and two hashes: the upstream file at the
 * pinned commit (drift) and kiln's body under the note (tamper). A verbatim copy's two are equal.
 */

export const NOTE_OPENING = "> **In kiln:**";
export const KINDS = ["verbatim", "edited", "excerpt"];
export const SOURCES = { "agent-skills": "agent-skills", superpowers: "superpowers", bmad: "BMAD-METHOD" };

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function hasNote(text) {
  return text.startsWith(NOTE_OPENING);
}

/** The source's text under kiln's note: everything after the note's `>` lines and the blank line below them. */
export function copyBody(text) {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => !line.startsWith(">"));
  return lines.slice(lines[end] === "" ? end + 1 : end).join("\n");
}

/**
 * The skills of the three sources at the commits kiln read, by name. A copy that names one must
 * name a file kiln ships under that name; "brainstorming" is also an ordinary word, so it is left out.
 */
export const SOURCE_SKILL_NAMES = [
  "api-and-interface-design", "browser-testing-with-devtools", "ci-cd-and-automation", "code-review-and-quality",
  "code-simplification", "constraint-driven-development", "context-engineering", "debugging-and-error-recovery",
  "deprecation-and-migration", "documentation-and-adrs", "doubt-driven-development", "frontend-ui-engineering",
  "git-workflow-and-versioning", "idea-refine", "incremental-implementation", "interview-me",
  "observability-and-instrumentation", "performance-optimization", "planning-and-task-breakdown", "security-and-hardening",
  "shipping-and-launch", "source-driven-development", "spec-driven-development", "test-driven-development", "using-agent-skills",
  "diagnosing-superpowers", "dispatching-parallel-agents", "executing-plans", "finishing-a-development-branch",
  "receiving-code-review", "requesting-code-review", "subagent-driven-development", "systematic-debugging",
  "using-git-worktrees", "using-superpowers", "verification-before-completion", "writing-plans", "writing-skills",
  "bmad-build", "bmad-build-auto", "bmad-code-review", "bmad-review", "bmad-spec", "bmad-architecture", "bmad-walkthrough",
  "bmad-project-context", "bmad-deep-recon", "bmad-correct-course", "bmad-retrospective", "bmad-qa-generate-e2e-tests",
];

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

function shapeProblems(entry) {
  const problems = [];
  if (!KINDS.includes(entry.kind) || !SOURCES[entry.source] || !/^[0-9a-f]{40}$/.test(entry.commit ?? "")) problems.push(`${entry.path}: kind, source or commit is not valid`);
  if (entry.kind !== "verbatim" && !(entry.edits?.length > 0)) problems.push(`${entry.path}: an ${entry.kind} copy lists its edits`);
  return problems;
}

function textProblems(entry, text) {
  const problems = [];
  if (!hasNote(text)) problems.push(`${entry.path}: does not open with the kiln note (${NOTE_OPENING})`);
  if (sha256(copyBody(text)) !== entry.kiln_sha256) problems.push(`${entry.path}: body does not match its recorded hash — changed without recording it (node scripts/upstream.mjs record)`);
  if (entry.kind === "verbatim" && entry.kiln_sha256 !== entry.upstream_sha256) problems.push(`${entry.path}: recorded as verbatim but differs from upstream`);
  return problems;
}

function entryProblems(root, entry) {
  const where = join(root, entry.path);
  if (!existsSync(where)) return [`${entry.path}: listed in skills/copies.json but missing`];
  return [...shapeProblems(entry), ...textProblems(entry, readFileSync(where, "utf8"))];
}

/** A source skill named in a copy or a kiln page must be a file kiln ships under that name. */
function danglingNames(root, files) {
  const shipped = new Set(files.map((file) => basename(file, ".md")));
  return files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return SOURCE_SKILL_NAMES.filter((name) => !shipped.has(name) && new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)).map((name) => `${relative(root, file)}: names ${name}, which kiln does not ship`);
  });
}

/** Everything wrong with the copies under `root`'s skills directory; empty when all is recorded. */
export function copyProblems(root) {
  const skills = join(root, "skills");
  const entries = JSON.parse(readFileSync(join(skills, "copies.json"), "utf8"));
  const listed = new Set(entries.map((entry) => entry.path));
  const files = markdownFiles(skills).filter((file) => !file.includes(`${sep}kiln-dna${sep}`));
  const unlisted = files.filter((file) => hasNote(readFileSync(file, "utf8")) && !listed.has(relative(root, file))).map((file) => `${relative(root, file)}: carries the kiln note but is not in skills/copies.json`);
  return [...entries.flatMap((entry) => entryProblems(root, entry)), ...unlisted, ...danglingNames(root, files)];
}
