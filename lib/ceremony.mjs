import { AUTHORIZING, SHIP_AUTHORIZING } from "./state.mjs";

export class CeremonyError extends Error {}

/**
 * Classification is the terminal act of INVESTIGATE and produces no artifact, so it is
 * not a stage (D28). This table is what the classification then selects: which stages
 * run, and where the user has to act.
 */
export const CEREMONY = Object.freeze({
  spike: {
    rung: 0,
    stages: ["INVESTIGATE", "IMPLEMENT"],
    gates: ["probe"],
    artifacts: ["brief.md", "findings.md"],
    ships: false,
  },
  bounded: {
    rung: 1,
    stages: ["INVESTIGATE", "PLAN", "IMPLEMENT", "REVIEW", "VERIFY", "SHIP"],
    gates: ["plan", "review"],
    artifacts: ["brief.md", "plan.md", "review.md"],
    ships: true,
  },
  full: {
    rung: 2,
    stages: ["INVESTIGATE", "SPEC", "PLAN", "IMPLEMENT", "REVIEW", "VERIFY", "SHIP"],
    gates: ["spec", "plan", "review", "ship"],
    artifacts: ["brief.md", "spec.md", "plan.md", "review.md"],
    ships: true,
  },
});

export const PATHS = Object.freeze(Object.keys(CEREMONY));

export function ceremonyFor(path) {
  const found = CEREMONY[path];
  if (!found) throw new CeremonyError(`unknown ceremony path "${path}". One of: ${PATHS.join(", ")}.`);
  return found;
}

/** Every path's authorizing keys come from one table, so they cannot drift apart. */
export function gateKeysFor(path) {
  ceremonyFor(path);
  return { source: AUTHORIZING[path], ship: SHIP_AUTHORIZING[path] };
}

/**
 * One-way. Cutting spike would push a vague ticket into `full` under "when in doubt take
 * the heavier path", which is how an hour goes into a spec built on guesses (D12) — and
 * letting the ratchet fall back down would make the same ticket cheap again after the
 * investigation that proved it was not.
 */
/**
 * The ban on going down exists to stop a task that proved large becoming cheap again, and
 * to stop pre-plan code being laundered past a gate written for a different artifact. Both
 * need something to launder. A work with no gate recorded and nothing changed has neither,
 * and that is exactly the state a work is in between `kiln open` and classification — which
 * is where the path is actually chosen.
 */
export function canRatchet(from, { to, untouched = false }) {
  if (from === to) return false;
  return untouched || ceremonyFor(to).rung > ceremonyFor(from).rung;
}

export function ratchetRefusal(from, to) {
  if (from === to) return `already on ${from}`;
  return `the ratchet only goes up once a gate is recorded or the tree has changed: ${from} cannot become ${to}`;
}

/**
 * Eligibility comes from the classifier, after investigation (D16). A spike's output is
 * a question, so there is nothing for auto mode to rule on — no flag reaches that.
 *
 * Two levers, and the run's own beats the standing one. `--auto` typed into the request is
 * a human instruction in the user's own message; `auto.*` in config is a default someone
 * set once. The flag is also the only lever an agent can honour: the harness refuses an
 * agent editing the config that governs its own gates, and refuses it by name —
 * `[Self-Modification]` — so config can only be changed by the user at their own terminal.
 *
 * That is why the flag satisfies `full`'s explicit opt-in as well. `auto.full` was asking
 * for a deliberate human act, and typing it into the request is one.
 */
const STANDING = {
  full: { key: "auto.full", off: "full requires an explicit opt-in — `--auto` in the request, or auto.full in config" },
  bounded: { key: "auto.bounded", off: "auto is off — add `--auto` to the request, or set auto.bounded" },
};

function standingVerdict(path, config) {
  const rule = STANDING[path];
  const on = (config.auto ?? {})[path] === true;
  return on ? { eligible: true, from: rule.key } : { eligible: false, reason: rule.off };
}

export function autoEligible(path, { config = {}, state = null } = {}) {
  if (path === "spike") return { eligible: false, reason: "a spike's output is a question, not a change" };
  if (state !== null && state.auto === true) return { eligible: true, from: "the --auto in your request" };
  return standingVerdict(path, config);
}

function ruledLines(gates) {
  return Object.entries(gates)
    .filter(([, record]) => record.by === "auto")
    .map(([key, record]) => `  ${key} → ${record.decision}   (${record.answer})`);
}

/**
 * Without this block auto mode is a black box, and a black box is not trusted twice. A
 * run that ruled on the user's behalf and does not print it is a failure, not a tidier
 * report — which is why this returns null rather than an empty string when there is
 * nothing to declare.
 */
export function renderAutoRuled(state) {
  const lines = ruledLines(state.gates ?? {});
  if (lines.length === 0) return null;
  const halts = (state.carry_over ?? []).filter((row) => row.kind === "halt");
  return [
    `Auto-ruled ${lines.length} gate${lines.length === 1 ? "" : "s"}:`,
    ...lines,
    `Halts: ${halts.length === 0 ? "none" : halts.map((row) => row.text).join("; ")}`,
    "Your gate is now the PR.",
  ].join("\n");
}

/**
 * Conventional Commits' own vocabulary, unchanged. A branch prefix is the one place every
 * team already agrees on a word list, so kiln does not invent one — and `chore` is the
 * standard's catch-all, which is what a work gets when nothing in the request says more.
 */
export const TYPES = Object.freeze(["feat", "fix", "chore", "docs", "refactor", "test", "perf", "build", "ci", "style", "revert"]);

export const DEFAULT_TYPE = "chore";

/**
 * The implement contract borrows superpowers' rule verbatim: "Do not pause to check in with
 * your human partner between tasks. Execute all tasks from the plan without stopping." On a
 * five-hour run the agent stopped twice anyway, and when asked why, answered: "the skill
 * says run continuously and I've been pausing anyway."
 *
 * It did not decide to ask. Both stops came right after a summary table, and both ended on a
 * sentence announcing the opposite — "Continuing with Tasks 3-8", then nothing. A summary is
 * a closing gesture; the turn ended on the gesture.
 *
 * Superpowers carries the same rule on a structure kiln declined — a subagent per task, so
 * the controller never reaches a task boundary at all. BMAD carries story status the same
 * way: "status is written by the build", not narrated by the agent, and its issues #387 and
 * #496 are what happens when only prose holds it.
 *
 * So no new verb and no more prose: the line rides on the call the contract already makes
 * mandatory after every task, and the position it reports is written to state by kiln.
 */
export function taskPosition(raw) {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(raw ?? "").trim());
  if (!match) return null;
  const [task, of] = [Number(match[1]), Number(match[2])];
  return task >= 1 && task <= of ? { task, of } : null;
}

export function nextMove(step) {
  if (!step) return null;
  return step.task < step.of
    ? `Task ${step.task} of ${step.of} recorded. Task ${step.task + 1} is next — do not stop, and do not summarise.`
    : `Task ${step.of} of ${step.of} recorded. Every task is done; next is the review gate.`;
}
