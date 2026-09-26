import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "./rules.mjs";

/**
 * D188: which of the practices kiln copied from superpowers, agent-skills and BMAD a stage of
 * this work must read. The sources route by a model matching skill descriptions, which did not
 * fire for kiln's stage skills; kiln decides in code, the way D101 routes project rules.
 *
 * A trigger is `always`, `path:<spike|bounded|full>`, `auto`, `flag:<risk flag>`,
 * `glob:<path glob>`, `content:<regex over added lines>`, `surface:<API|SCREEN|BATCH|ENTITY>`
 * or `route:<quick|thorough>`. Each answers true, false, or unknown when code cannot tell.
 * A practice is read when any trigger is true, or when every trigger is unknown — fire, don't
 * skip: a file is left out only when code can say it does not apply.
 */

export class PracticesError extends Error {}

export const RISK_FLAGS = Object.freeze(["security", "performance", "migration", "public-api", "ui"]);
export const PRACTICE_STAGES = Object.freeze(["investigate", "plan", "implement", "review", "ship"]);

/** BMAD's line between its quick and thorough review, measured on the change rather than estimated. */
const QUICK = { lines: 100, files: 5 };

const SECTION = /^## Risk flags[ \t]*$/im;

function sectionLines(text) {
  const start = SECTION.exec(text);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(/^## /m);
  return (end === -1 ? rest : rest.slice(0, end)).split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * The plan's `## Risk flags` section: one `- <flag>: <why>` line per flag, or `- none`.
 * No section is `null` — unknown, not "none"; a flag kiln does not know is refused, since a
 * misspelt flag would otherwise route nothing and say nothing.
 */
export function riskFlags(planText) {
  const lines = sectionLines(planText ?? "");
  if (lines === null) return null;
  const named = lines.map((line) => /^[-*]\s*([a-z-]+)/i.exec(line)?.[1]?.toLowerCase()).filter(Boolean);
  const unknown = named.filter((name) => name !== "none" && !RISK_FLAGS.includes(name));
  if (unknown.length > 0) throw new PracticesError(`the plan's Risk flags name ${unknown.join(", ")}; the flags are ${RISK_FLAGS.join(", ")}, or "none".`);
  if (named.length === 0) throw new PracticesError(`the plan's Risk flags section is empty. Write "- none" when you checked and found none.`);
  return new Set(named.filter((name) => name !== "none"));
}

export function reviewRoute(facts) {
  return facts.lines <= QUICK.lines && facts.files.length <= QUICK.files ? "quick" : "thorough";
}

function anyAdded(facts, pattern) {
  return [...facts.added.values()].some((text) => pattern.test(text));
}

const EVALUATORS = {
  always: () => true,
  path: (value, facts) => facts.path === value,
  auto: (value, facts) => facts.auto === true,
  flag: (value, facts) => (facts.flags ? facts.flags.has(value) : null),
  glob: (value, facts) => (facts.files?.length ? facts.files.some((file) => globToRegExp(value).test(file)) : null),
  content: (value, facts) => (facts.added ? anyAdded(facts, new RegExp(value, "m")) : null),
  surface: (value, facts) => (facts.kinds ? [...facts.kinds.values()].includes(value) : null),
  route: (value, facts) => (facts.lines === null || facts.files === null ? null : reviewRoute(facts) === value),
};

export function evaluateTrigger(trigger, facts) {
  const at = trigger.indexOf(":");
  const [kind, value] = at === -1 ? [trigger, ""] : [trigger.slice(0, at), trigger.slice(at + 1)];
  const evaluate = EVALUATORS[kind];
  if (!evaluate) throw new PracticesError(`"${trigger}" is not a trigger; one of ${Object.keys(EVALUATORS).join(", ")} is.`);
  return evaluate(value, facts);
}

/**
 * agent-skills' `/ship` rule for skipping its specialists: a change of `files_at_most` files and
 * fewer than `lines_below` lines that touches none of `unless`. An `unless` code cannot decide
 * counts as touched, so an unsure case is reviewed.
 */
function skipped(practice, facts) {
  const rule = practice.skip;
  if (!rule || facts.files === null || facts.lines === null) return false;
  if (facts.files.length > rule.files_at_most || facts.lines >= rule.lines_below) return false;
  return (rule.unless ?? []).every((trigger) => evaluateTrigger(trigger, facts) === false);
}

function verdict(practice, facts) {
  const answers = practice.when.map((trigger) => ({ trigger, answer: evaluateTrigger(trigger, facts) }));
  const hit = answers.find((each) => each.answer === true);
  if (hit) return skipped(practice, facts) ? null : hit.trigger;
  return answers.every((each) => each.answer === null) ? `${practice.when.join(" or ")} — undecided, so read` : null;
}

/** The practices `stage` must read, each with the trigger that selected it. */
export function selectPractices(practices, { stage, facts }) {
  return practices.filter((practice) => practice.stage === stage).flatMap((practice) => {
    const why = verdict(practice, facts);
    return why ? [{ ...practice, why }] : [];
  });
}

export function practicesPath(pluginRoot) {
  return join(pluginRoot, "skills", "practices.json");
}

export function loadPractices(pluginRoot) {
  const path = practicesPath(pluginRoot);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}
