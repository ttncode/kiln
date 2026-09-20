import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gitOutput } from "./init.mjs";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "vendor", "coverage", ".next"]);
const MAX_BYTES = 512 * 1024;
const TEXT = /\.(m?[jt]sx?|php|py|rb|go|java|kt|cs|rs|sql|json|ya?ml|md|html|css|scss)$/i;

function walk(dir, root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name === ".kiln") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, root);
    return TEXT.test(entry.name) && statSync(path).size <= MAX_BYTES ? [relative(root, path)] : [];
  });
}

function escapeTerm(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Knowledge tier 0. A real grep, never a no-op (D47): the port has to be genuinely
 * exercised at v1 or the question of whether it should exist cannot be answered by
 * anything but argument.
 */
export function grepBlastRadius(root, terms) {
  const patterns = terms.filter(Boolean).map((term) => new RegExp(escapeTerm(term), "i"));
  if (patterns.length === 0) return [];

  return walk(root, root)
    .map((path) => ({ path, hits: countHits(join(root, path), patterns) }))
    .filter((row) => row.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
}

function countHits(absolute, patterns) {
  try {
    const text = readFileSync(absolute, "utf8");
    return patterns.filter((pattern) => pattern.test(text)).length;
  } catch {
    return 0;
  }
}

/**
 * The status field is one or two characters wide and may lose its leading space to a
 * trim, so a fixed slice is off by one on exactly the modified-tracked-file case — and
 * it produces a path that looks almost right (`rc/a.ts`), which reconciliation would
 * then report as beyond prediction forever.
 */
export function statusPathOf(line) {
  const path = line.replace(/^.{0,2}\s+/, "");
  return path.includes(" -> ") ? path.split(" -> ").pop() : path;
}

function statusPaths(root) {
  const output = gitOutput(root, ["status", "--short"]) ?? "";
  return output.split("\n").filter(Boolean).map(statusPathOf);
}

/** kiln's own artifacts are not the change under review; predicted[] holds source. */
function isSource(path) {
  return path !== "" && !path.startsWith(".kiln/") && path !== ".kiln";
}

/**
 * Three dots is merge-base semantics, which is what keeps a moved integration branch
 * from showing its newer files as phantom deletions (superpowers #2133).
 */
export function actualChanged(root, from) {
  const committed = (gitOutput(root, ["diff", "--name-only", `${from}...HEAD`]) ?? "").split("\n").filter(Boolean);
  return [...new Set([...committed, ...statusPaths(root)])].filter(isSource).sort();
}

function pathsOf(predicted) {
  return (predicted ?? []).map((row) => (typeof row === "string" ? row : row.path)).filter(Boolean);
}

export function reconcile({ predicted, actual }) {
  const claimed = new Set(pathsOf(predicted));
  const touched = new Set(actual);
  return {
    predicted: claimed.size,
    actual: touched.size,
    beyond: [...touched].filter((path) => !claimed.has(path)),
    notTouched: [...claimed].filter((path) => !touched.has(path)),
  };
}

/** Statistics reach the conversation; the diff body stays a file read on demand (D67b). */
export function reconciliationLine(result) {
  const parts = [`Scope — predicted ${result.predicted} · actual ${result.actual}`];
  if (result.beyond.length > 0) parts.push(`⚠ ${result.beyond.length} beyond prediction`);
  if (result.notTouched.length > 0) parts.push(`${result.notTouched.length} predicted-not-touched`);
  return parts.join(" · ");
}

/**
 * Reports and never blocks (D31) — discovery during implementation is legitimate — with
 * one exception. A diff of zero files is not divergence, it is the absence of the thing
 * under review, and its common cause is an implementer who committed to another branch
 * (D56, upstream #2136).
 */
export function reconcileVerdict(result) {
  if (result.actual === 0) {
    return { halt: true, reason: "nothing changed in this range. The usual cause is a commit on another branch." };
  }
  return { halt: false };
}
