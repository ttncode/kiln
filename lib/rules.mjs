import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInside } from "./paths.mjs";

/**
 * The half of D20 that was never built. `kiln init` wrote the router, `kiln doctor` checked
 * every file was routed, and no stage ever read one — so a project could file a rule, route
 * it correctly, watch doctor print `all routed`, and have the agent edit the very file the
 * rule was about without seeing it.
 *
 * Prior art decided the shape. Cursor's rules resolve four ways from three frontmatter
 * fields, and the one that generates nearly every report of a rule "being ignored" is the
 * one where the model decides from a description whether the rule is relevant. kiln keeps
 * the other kind: the trigger is a path glob, the match is computed here, and what the agent
 * was handed is recorded — so *this rule applied* is a fact rather than a hope.
 */
export function rulesDir(root) {
  return join(root, ".kiln", "rules");
}

export function indexPath(root) {
  return join(rulesDir(root), "index.md");
}

/**
 * The first markdown table, minus its header. The separator row is what distinguishes the
 * two: read top-down without it, `| Trigger | Rule file |` becomes a route sending every
 * path in the project to a file named "Rule file".
 */
function tableBody(text) {
  const rows = [];
  let started = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      if (started) break;
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(line)) started = true;
    else if (started) rows.push(line);
  }
  return rows;
}

function cellsOf(row) {
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.replaceAll("`", "").trim());
}

/** An italic cell is how the shipped template says "nothing yet"; a dash is how a table does. */
function isBlank(cell) {
  return cell === "" || /^[—–-]+$/.test(cell) || /^_.*_$/.test(cell);
}

/** A path written `./src/x` and a path written `src/x` are the same path. */
function normalise(path) {
  return path.replace(/^\.?\//, "");
}

const GLOB_TOKENS = { "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" };

/**
 * `*` stops at a separator, `**` crosses one, everything else is a literal. Escaping the
 * literal parts is what keeps a trigger that happens to look like a regex (`^src/.*$`) a
 * string being matched rather than a second pattern language nobody declared.
 */
function globToRegExp(glob) {
  const source = normalise(glob)
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => GLOB_TOKENS[part] ?? part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(`^${source}$`);
}

function classify(cells, root) {
  const [trigger = "", file = ""] = cells;
  const row = { trigger, file };
  if (isBlank(trigger) && isBlank(file)) return { ...row, state: "empty" };
  if (isBlank(trigger) || isBlank(file)) return { ...row, state: "half" };

  const path = resolve(rulesDir(root), file);
  if (!isInside(rulesDir(root), path)) return { ...row, state: "escapes" };
  if (!existsSync(path)) return { ...row, state: "missing" };
  return { ...row, state: "route", path, match: globToRegExp(trigger) };
}

/**
 * Every row, classified — the broken ones by name, because the failure this router has to
 * avoid is the one Cursor's users hit: a malformed rule is skipped with no warning and no
 * log, and the only symptom is an agent that quietly does not follow it.
 */
export function readRoutes(root) {
  if (!existsSync(indexPath(root))) return [];
  return tableBody(readFileSync(indexPath(root), "utf8")).map((row) => classify(cellsOf(row), root));
}

/** Deduped by file: one rule routed under two triggers is still one rule to read. */
export function matchingRules(root, paths) {
  const wanted = paths.map(normalise);
  const hits = readRoutes(root).filter((row) => row.state === "route" && wanted.some((path) => row.match.test(path)));
  return [...new Map(hits.map((row) => [row.file, row])).values()];
}

export const STAGES = Object.freeze(["plan", "review"]);

const NO_PATHS = {
  plan: "The plan names no files yet, so there is nothing to match a rule against. Write the change preview first.",
  review: "This run has changed no files yet, so there is nothing to match a rule against.",
};

function countedLine(routes, paths) {
  const routed = routes.filter((row) => row.state === "route").length;
  return `${routed} rule(s) routed · matched against ${paths.length} file(s) this stage names`;
}

function quoted(row) {
  return `\n--- ${row.file} · routed from ${row.trigger} ---\n${readFileSync(row.path, "utf8").trimEnd()}`;
}

/**
 * The counts are printed even when nothing matches. "No rules apply" and "the router is
 * empty" and "the stage named no files" are three different facts, and a run that prints
 * silence for all three teaches the reader that the line means nothing.
 */
export function rulesReport({ root, stage, id, paths }) {
  const head = `Rules — ${stage} · ${id}`;
  if (paths.length === 0) return { files: [], text: `${head}\n${NO_PATHS[stage]}` };

  const routes = readRoutes(root);
  if (routes.every((row) => row.state !== "route")) {
    return { files: [], text: `${head}\nNo rule is routed in ${indexPath(root)}, so this stage has none to apply.` };
  }

  const matched = matchingRules(root, paths);
  const counted = `${head}\n${countedLine(routes, paths)}`;
  if (matched.length === 0) return { files: [], text: `${counted}\nNone of them match.` };
  return { files: matched.map((row) => row.file), text: [counted, ...matched.map(quoted)].join("\n") };
}
