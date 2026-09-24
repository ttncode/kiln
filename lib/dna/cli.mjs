import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseJsonText } from "../config.mjs";
import { applyBatch, checkStore } from "./apply.mjs";
import { renderGates } from "./gates.mjs";
import { DnaError, hasStore } from "./store.mjs";

export const DNA_USAGE = `  kiln dna [status]
      What the DNA store holds, what it was pinned to, and whether its gates pass.

  kiln dna check
      Every gate, one line each. Exits 1 when a blocking gate fails.

  kiln dna apply <batch.json>
      The one way into .kiln/dna/store/. Adds or changes records, assigns the ids the
      contract counts, derives what the store computes, and writes only if every
      gate passes. Prints each id it assigned.

  kiln dna build
      Derive the computed fields again from the records as they stand.`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readBatch(path) {
  if (!path) throw new DnaError("kiln dna apply needs a batch file: kiln dna apply <batch.json>");
  try {
    return parseJsonText(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new DnaError(`${path} could not be read as a batch: ${error.message}`);
  }
}

function countsLine(manifest) {
  const held = Object.entries(manifest.counts).filter(([, count]) => count > 0);
  return held.length > 0 ? held.map(([name, count]) => `${name} ${count}`).join(" · ") : "no records";
}

function pinsLine(manifest) {
  const pins = Object.entries(manifest.source_pins ?? {});
  return pins.length > 0 ? `pinned to ${pins.map(([ref, sha]) => `${ref} ${String(sha).slice(0, 12)}`).join(", ")}` : "not pinned to any commit yet";
}

function runStatus(root, out) {
  if (!hasStore(root)) return out("No DNA store in this project yet (.kiln/dna/store/).") ?? 0;
  const report = checkStore(root);
  const { manifest } = report;
  out(`DNA store · ${manifest.project} · methodology ${manifest.dna_methodology_version} · built ${manifest.generated_at}`);
  out(`  ${countsLine(manifest)}`);
  out(`  ${pinsLine(manifest)}`);
  out(`  gates: ${report.failed.length === 0 ? "all pass" : `${report.failed.length} failing — kiln dna check`}${report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : ""}`);
  return 0;
}

function runCheck(root, out) {
  if (!hasStore(root)) return out("No DNA store in this project yet (.kiln/dna/store/).") ?? 1;
  const report = checkStore(root);
  out(renderGates(report));
  out(report.failed.length === 0 ? `RESULT: PASS (${report.warnings.length} warning(s))` : `RESULT: FAIL (${report.failed.length} blocking)`);
  return report.failed.length === 0 ? 0 : 1;
}

function runApply(root, { argv, out }) {
  const plan = applyBatch(root, { batch: readBatch(argv[0]), today: today() });
  for (const { id, key } of plan.assigned) out(key === undefined ? `  ${id}` : `  ${id} ← ${key}`);
  out(`Store written: ${plan.gates.results.filter((result) => result.bad).length} gates passed${plan.gates.warnings.length > 0 ? `, ${plan.gates.warnings.length} warning(s) — kiln dna check` : ""}.`);
  return 0;
}

function runBuild(root, out) {
  const plan = applyBatch(root, { batch: {}, today: today() });
  out(`Store derived again: ${plan.gates.warnings.length} warning(s).`);
  return 0;
}

/** `argv` is what followed `kiln dna`. */
export function runDnaCommand(root, { argv, out }) {
  const [verb = "status", ...rest] = argv;
  if (verb === "status") return runStatus(root, out);
  if (verb === "check") return runCheck(root, out);
  if (verb === "apply") return runApply(root, { argv: rest, out });
  if (verb === "build") return runBuild(root, out);
  throw new DnaError(`kiln dna has no verb "${verb}".\n${DNA_USAGE}`);
}
