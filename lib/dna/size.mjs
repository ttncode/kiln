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

/** The pace of this project's own recorded rounds, from `metrics` on its update records. */
export function recordedPace(updates) {
  const measured = updates.map((update) => update.ext?.metrics).filter((metrics) => metrics?.lines_scanned > 0 && metrics?.minutes > 0);
  if (measured.length === 0) return null;
  const lines = measured.reduce((sum, metrics) => sum + metrics.lines_scanned, 0);
  const minutes = measured.reduce((sum, metrics) => sum + metrics.minutes, 0);
  const costed = measured.filter((metrics) => metrics.cost_usd > 0);
  const costLines = costed.reduce((sum, metrics) => sum + metrics.lines_scanned, 0);
  const cost = costed.reduce((sum, metrics) => sum + metrics.cost_usd, 0);
  return { rounds: measured.length, linesPerMinute: lines / minutes, costPerKiloLine: costLines > 0 ? (cost / costLines) * 1000 : null };
}

function paceLine(size, pace) {
  if (!pace) return "no round of this project has been recorded yet, so there is no time estimate — agree a cap before dispatching";
  const minutes = Math.ceil(size.lines / pace.linesPerMinute);
  const cost = pace.costPerKiloLine === null ? "" : `, about $${((size.lines / 1000) * pace.costPerKiloLine).toFixed(2)}`;
  return `at the pace of ${pace.rounds} recorded round(s): about ${minutes} min${cost} — taken from past rounds, not a promise`;
}

/** Two lines: the exact size, then the pace or the plain statement that there is none. */
export function sizeLines(files, updates) {
  if (files.length === 0) return [];
  const size = workSize(files);
  return [
    `to read: ${size.files} file(s) · ${size.lines} line(s) · ${size.skeletons} skeleton(s) · ${size.waves} wave(s) of up to ${WAVE} subagents`,
    paceLine(size, recordedPace(updates)),
  ];
}
