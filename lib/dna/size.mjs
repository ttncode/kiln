import { groupFiles } from "./scan.mjs";

/**
 * What a scan or update round is about to cost, said before it starts. The size is exact —
 * files, lines, skeletons, waves — because it is counted. Time and cost are not: no mature
 * agent tool forecasts them (Claude Code, SWE-agent, Aider and OpenHands cap spend and report
 * it afterwards), so a figure is shown only once this project has recorded rounds to take a
 * pace from, and it is labelled as that. The cap that bounds a round is the user's to set.
 */

export const WAVE = 6;

export function workSize(files) {
  const skeletons = groupFiles(files).length;
  return { files: files.length, lines: files.reduce((sum, file) => sum + (file.total ?? 0), 0), skeletons, waves: Math.ceil(skeletons / WAVE) };
}

const counted = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

function updatePace(updates) {
  const measured = updates.map((update) => update.ext?.metrics).filter((metrics) => counted(metrics?.lines_scanned) && counted(metrics?.minutes));
  if (measured.length === 0) return null;
  const lines = measured.reduce((sum, metrics) => sum + metrics.lines_scanned, 0);
  return { rounds: measured.length, linesPerMinute: lines / measured.reduce((sum, metrics) => sum + metrics.minutes, 0) };
}

function costPerKiloLine(updates) {
  const costed = updates.map((update) => update.ext?.metrics).filter((metrics) => counted(metrics?.lines_scanned) && counted(metrics?.cost_usd));
  const lines = costed.reduce((sum, metrics) => sum + metrics.lines_scanned, 0);
  return lines > 0 ? (costed.reduce((sum, metrics) => sum + metrics.cost_usd, 0) / lines) * 1000 : null;
}

/**
 * D177: skeletons written by one `kiln dna scan --out` share a start and are read side by side,
 * so a round's time is its last apply less that start, not the sum of each skeleton's own.
 */
function roundPace(rounds) {
  const byStart = new Map();
  for (const round of rounds) {
    const seen = byStart.get(round.started) ?? { lines: 0, finished: round.started };
    byStart.set(round.started, { lines: seen.lines + round.lines, finished: Math.max(seen.finished, round.finished) });
  }
  const measured = [...byStart].map(([started, round]) => ({ lines: round.lines, minutes: (round.finished - started) / 60 })).filter((round) => counted(round.lines) && counted(round.minutes));
  if (measured.length === 0) return null;
  const lines = measured.reduce((sum, round) => sum + round.lines, 0);
  return { rounds: measured.length, linesPerMinute: lines / measured.reduce((sum, round) => sum + round.minutes, 0) };
}

/**
 * The pace of this project's own recorded rounds. The rounds `apply` timed (D177) come first:
 * an update's `metrics` spans rounds already among them, so it is read only for a store that has
 * none — and for cost, which only a person reading `/cost` can supply.
 */
export function recordedPace({ updates = [], rounds = [] }) {
  const pace = roundPace(rounds) ?? updatePace(updates);
  return pace ? { ...pace, costPerKiloLine: costPerKiloLine(updates) } : null;
}

function paceLine(size, pace) {
  if (!pace) return "no round of this project has been recorded yet, so there is no time estimate — agree a cap before dispatching";
  const minutes = Math.ceil(size.lines / pace.linesPerMinute);
  const cost = pace.costPerKiloLine === null ? "" : `, about $${((size.lines / 1000) * pace.costPerKiloLine).toFixed(2)}`;
  return `at the pace of ${pace.rounds} recorded round(s): about ${minutes} min${cost} — taken from past rounds, not a promise`;
}

/** Two lines: the exact size, then the pace or the plain statement that there is none. */
export function sizeLines(files, history) {
  if (files.length === 0) return [];
  const size = workSize(files);
  return [
    `to read: ${size.files} file(s) · ${size.lines} line(s) · ${size.skeletons} skeleton(s) · ${size.waves} wave(s) of up to ${WAVE} subagents`,
    paceLine(size, recordedPace(history)),
  ];
}
