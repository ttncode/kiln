import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInside, isSymlink } from "./paths.mjs";
import { gitOutput } from "./init.mjs";

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
  return { started, rows };
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

/**
 * `resolve` is string arithmetic and does not know what a symlink is, so `| src/** |
 * secrets.md |` with `secrets.md -> /etc/hostname` resolved to a path inside `.kiln/rules/`
 * and the router read it. Measured: `kiln rules` printed the machine's hostname into the
 * run. Point the link at `.env` or a private key instead and the router is a file-read
 * primitive that puts the contents in front of the agent.
 *
 * D52 settled this for writes — a symlink leaf is rejected, not followed, which is the
 * primitive agent-skills #295 rates High — and the reader did not get the same rule. A
 * directory in the middle of the path is checked too: refusing only the leaf leaves
 * `rules/theirs/x.md` where `theirs` is the link.
 */
function escapesThroughLink(root, path) {
  if (isSymlink(path)) return true;
  try {
    return !isInside(realpathSync(rulesDir(root)), realpathSync(path));
  } catch {
    return false;
  }
}

function classify(cells, root) {
  const [trigger = "", file = ""] = cells;
  const row = { trigger, file };
  if (isBlank(trigger) && isBlank(file)) return { ...row, state: "empty" };
  if (isBlank(trigger) || isBlank(file)) return { ...row, state: "half" };

  const path = resolve(rulesDir(root), file);
  if (!isInside(rulesDir(root), path) || escapesThroughLink(root, path)) return { ...row, state: "escapes" };
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
  const text = readFileSync(indexPath(root), "utf8");
  const { started, rows } = tableBody(text);
  const anyPipe = text.split("\n").some((line) => line.trim().startsWith("|"));
  if (!started && anyPipe) return [{ trigger: "", file: "", state: "no-table" }];
  return rows.map((row) => classify(cellsOf(row), root));
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

/**
 * A row the router cannot resolve is reported where the run happens, not only where a
 * person runs doctor. Cursor drops a malformed rule silently, and the whole cost of that
 * bug is that there is no symptom: the rule is filed, it is routed, and the agent behaves
 * as though it had never been written.
 */
const UNRESOLVED = new Set(["half", "escapes", "missing", "no-table"]);

function unresolvedLine(routes) {
  const broken = routes.filter((row) => UNRESOLVED.has(row.state)).length;
  return broken === 0 ? null : `${broken} row(s) here do not resolve and were not applied — \`kiln doctor\` says what is wrong with them.`;
}

function statusLine(routes, { paths, matched }) {
  const routed = routes.filter((row) => row.state === "route").length;
  if (routed === 0) return "No rule is routed here, so this stage has none to apply.";
  const counted = `${routed} rule(s) routed · matched against ${paths.length} file(s) this stage names`;
  return matched.length === 0 ? `${counted}\nNone of them match.` : counted;
}

function quoted(row) {
  return `\n--- ${row.file} · routed from ${row.trigger} ---\n${readFileSync(row.path, "utf8").trimEnd()}`;
}

/**
 * The counts print even when nothing matches. "No rule applies", "the router is empty" and
 * "the stage named no files" are three different facts, and a run that prints silence for
 * all three teaches the reader that the line means nothing.
 */
export function rulesReport({ root, stage, id, paths }) {
  const head = `Rules — ${stage} · ${id}`;
  if (paths.length === 0) return { files: [], text: `${head}\n${NO_PATHS[stage]}` };

  const routes = readRoutes(root);
  const matched = matchingRules(root, paths);
  const lines = [head, statusLine(routes, { paths, matched }), unresolvedLine(routes), ...matched.map(quoted)];
  return { files: matched.map((row) => row.file), text: lines.filter(Boolean).join("\n") };
}


/**
 * D48 met this exact shape and answered it with a verb. Config holds terms the run is judged
 * by, so the agent may not write it, so `kiln config set` exists — and after D102 a project
 * rule sits in the same position with nothing on the other side. A user was told to hand-edit
 * a markdown table instead, and the table is where every comparable tool breaks: Cursor's
 * most-reported rules failure is a malformed file skipped in silence, and Cursor answers it
 * with `New Cursor Rule` and `/Generate Cursor Rules` rather than with documentation.
 *
 * **Add-only.** It creates a rule and routes it; it never edits or removes one. That is what
 * keeps D102 intact while letting the agent capture a decision: adding is visible in the diff
 * and lands in a committed file, weakening is not reachable at all.
 */
const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export class RulesError extends Error {}

function refuse(message) {
  throw new RulesError(message);
}

function checkName(file) {
  if (!RULE_NAME.test(file)) {
    refuse(`"${file}" cannot be a rule file: one name ending in .md, letters, digits, dot, dash or underscore — and it lives directly in .kiln/rules/.`);
  }
}

/**
 * A trigger matching nothing is a dead route, which `kiln doctor` already reports as a
 * warning. Refused here instead: at the moment of writing it the fix is one edit, and the
 * alternative is a rule filed, routed, and reaching nothing until somebody runs doctor.
 */
function trackedPaths(root) {
  const tracked = gitOutput(root, ["ls-files"]);
  return tracked === null ? null : tracked.split("\n").filter(Boolean).map(normalise);
}

function checkTrigger(root, trigger) {
  if (!trigger) refuse("a rule needs a trigger: the path glob that decides which files it covers.");
  const paths = trackedPaths(root);
  if (paths === null) return [];
  const match = globToRegExp(trigger);
  const covered = paths.filter((path) => match.test(path));
  if (covered.length === 0) {
    refuse(`"${trigger}" matches no file git lists here, so the rule would reach no stage.\nGlobs are repo-root relative: \`**/application/controllers/**\`, \`src/auth/**\`, \`**/*.sql\`.`);
  }
  return covered;
}

function ruleLines(root) {
  return readdirSync(rulesDir(root))
    .filter((name) => name.endsWith(".md"))
    .reduce((sum, name) => sum + readFileSync(join(rulesDir(root), name), "utf8").split("\n").length, 0);
}

/**
 * D20 mechanized two of its three questions and left the first — *can it merge into a rule
 * that already exists?* — as judgment. Judgment still needs its raw material, and the
 * material is a fact kiln can compute: which rules already cover the files this trigger
 * covers, and how many.
 *
 * The source says the quiet part, and D20 kept only the goal: *every rule line is a token
 * the agent pays on every later ticket, and the longer the rules get the lower the model's
 * compliance with each one — adding a rule to force compliance can backfire.* That is the
 * sentence that makes somebody shorten a rule; "total volume stays flat" on its own does not.
 * Cursor's users arrive at the same finding from the other side: past about ten always-on
 * rules the model satisfies none of them well.
 */
function overlapLine(root, { file, covered }) {
  if (covered.length === 0) return "1. merge?  no file list to compare against — git lists nothing here";
  const others = readRoutes(root).filter((row) => row.state === "route" && row.file !== file);
  const sharing = others
    .map((row) => ({ file: row.file, hits: covered.filter((path) => row.match.test(path)).length }))
    .filter((row) => row.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (sharing.length === 0) return `1. merge?  nothing else covers these ${covered.length} file(s)`;
  const named = sharing.map((row) => `${row.file} (${row.hits})`).join(", ");
  return `1. merge?  already covering these ${covered.length} file(s): ${named}\n             prefer editing one of those over keeping a new file`;
}

function budgetLine(root, { before, budget }) {
  const after = ruleLines(root);
  return `2. flat?   ${before} → ${after} lines of ${budget}. Every line is a token paid on every\n             later ticket, and per-item compliance falls as the total grows`;
}

/** D20's three questions, asked where the rule is written rather than where it is reviewed. */
export function theThreeQuestions(root, { file, covered, before, budget }) {
  return [
    "Before you keep this — the three questions (D20):",
    overlapLine(root, { file, covered }),
    budgetLine(root, { before, budget }),
    "3. routed? yes — this verb wrote the row, and `kiln doctor` re-checks it below",
  ];
}

function tableRow(trigger, file) {
  return `| ${trigger} | ${file} |`;
}

/**
 * Appended under the table's last row, not at the end of the file: the shipped template
 * carries prose after the table, and a row written below it is not in the table at all —
 * which `readRoutes` would then read as no route, silently.
 */
function withRow(text, row) {
  const lines = text.split("\n");
  let last = -1;
  let started = false;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at].trim();
    if (!line.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) started = true;
    if (started) last = at;
  }
  if (last === -1) return `${text.trimEnd()}\n\n| Trigger — a path glob | Rule file |\n|---|---|\n${row}\n`;
  return [...lines.slice(0, last + 1), row, ...lines.slice(last + 1)].join("\n");
}

const STUB = (file) => `# ${file.replace(/\.md$/, "")}\n\n- [ ] \n`;

function writeRule(root, { file, text }) {
  const path = join(rulesDir(root), file);
  if (existsSync(path)) {
    if (text) refuse(`.kiln/rules/${file} already exists. This verb adds rules; it never rewrites one — edit the file yourself, or route a new one.`);
    return [];
  }
  mkdirSync(rulesDir(root), { recursive: true });
  writeFileSync(path, text ? `${text.trimEnd()}\n` : STUB(file), "utf8");
  return [`created .kiln/rules/${file}`];
}

export function addRoute(root, { file, trigger, text, budget = 200 }) {
  checkName(file);
  const covered = checkTrigger(root, trigger);
  const before = existsSync(rulesDir(root)) ? ruleLines(root) : 0;

  const wrote = writeRule(root, { file, text });
  const routed = readRoutes(root).some((row) => row.file === file && row.trigger === trigger);
  if (!routed) {
    const index = indexPath(root);
    const text = existsSync(index) ? readFileSync(index, "utf8") : "# Project rules\n";
    writeFileSync(index, withRow(text, tableRow(trigger, file)), "utf8");
  }
  const done = [...wrote, routed ? `already routed: ${trigger} → ${file}` : `routed ${trigger} → ${file}`];
  return [...done, "", ...theThreeQuestions(root, { file, covered, before, budget })];
}
