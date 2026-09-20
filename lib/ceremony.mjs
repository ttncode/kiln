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
export function canRatchet(from, to) {
  return ceremonyFor(to).rung > ceremonyFor(from).rung;
}

export function ratchetRefusal(from, to) {
  if (from === to) return `already on ${from}`;
  return `the ratchet only goes up: ${from} cannot become ${to}`;
}

/**
 * Eligibility comes from the classifier, after investigation (D16). A spike's output is
 * a question, so there is nothing for auto mode to rule on.
 */
export function autoEligible(path, config) {
  if (path === "spike") return { eligible: false, reason: "a spike's output is a question, not a change" };
  if (path === "full") {
    return config?.auto?.full === true
      ? { eligible: true }
      : { eligible: false, reason: "full requires an explicit opt-in (auto.full)" };
  }
  return config?.auto?.bounded === true ? { eligible: true } : { eligible: false, reason: "auto.bounded is off" };
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
