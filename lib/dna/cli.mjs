import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseJsonText } from "../config.mjs";
import { isInside } from "../paths.mjs";
import { applyBatch, checkStore } from "./apply.mjs";
import { renderGates } from "./gates.mjs";
import { draftInfra } from "./infra.mjs";
import { groupFiles, scanProject, skeletons } from "./scan.mjs";
import { DnaError, hasStore, readStore } from "./store.mjs";

export const DNA_USAGE = `  kiln dna [status]
      What the DNA store holds, what it was pinned to, and whether its gates pass.

  kiln dna check
      Every gate, one line each. Exits 1 when a blocking gate fails.

  kiln dna scan [--limit <n>] [--out <dir under .kiln/tmp>]
      Every file of every repository at its integration branch, classed CANDIDATE,
      SHELL, TEST or OTHER; the unscanned candidates, densest first.
      --out  write one batch skeleton per group of the next <n> candidates (default
             30): the files, the commit they are read at, and where to read them.

  kiln dna infra [--out <file under .kiln/tmp>]
      Draft the store's services and surfaces as a batch, for a person to review
      before it is applied: a service per repository or top-level code directory
      and per database/cache/queue image a compose file names, a surface per file
      the stack's dna.surfaces rules match. Writes nothing to the store.

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

function runApply(root, { argv, out, config }) {
  const plan = applyBatch(root, { batch: readBatch(argv[0]), today: today(), config });
  for (const { id, key } of plan.assigned) out(key === undefined ? `  ${id}` : `  ${id} ← ${key}`);
  out(`Store written: ${plan.gates.results.filter((result) => result.bad).length} gates passed${plan.gates.warnings.length > 0 ? `, ${plan.gates.warnings.length} warning(s) — kiln dna check` : ""}.`);
  return 0;
}

const DEFAULT_LIMIT = 30;

function flagValue(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function repoLine(repo) {
  const where = `${repo.name}${repo.path ? ` (${repo.path})` : ""} at ${repo.ref} ${repo.commit.slice(0, 12)}`;
  return repo.pinnable ? where : `${where} — not the integration branch: it can be read, never pinned (D80)`;
}

function classCounts(files) {
  const count = (name) => files.filter((file) => file.class === name).length;
  const candidates = files.filter((file) => file.class === "CANDIDATE");
  const unscanned = candidates.filter((file) => !file.scanned).length;
  return `files ${files.length} · candidates ${candidates.length} (${candidates.length - unscanned} scanned, ${unscanned} unscanned) · shell ${count("SHELL")} · test ${count("TEST")} · other ${count("OTHER")}`;
}

function scratchTarget(root, path) {
  const target = resolve(path);
  if (!isInside(join(root, ".kiln", "tmp"), target)) throw new DnaError(`--out must be under ${join(root, ".kiln", "tmp")}: drafts are scratch.`);
  return target;
}

function writeSkeletons(root, { dir, repos, files }) {
  const target = scratchTarget(root, dir);
  mkdirSync(target, { recursive: true });
  return skeletons(root, { repos, groups: groupFiles(files) }).map((skeleton, index) => {
    const path = join(target, `scan-${String(index + 1).padStart(3, "0")}.json`);
    writeFileSync(path, `${JSON.stringify(skeleton, null, 1)}\n`);
    return relative(root, path);
  });
}

function runScan(root, { argv, out, config }) {
  const limit = Number(flagValue(argv, "--limit") ?? DEFAULT_LIMIT);
  const { repos, files } = scanProject(root, { config, ledger: readStore(root).scanned });
  for (const repo of repos) out(repoLine(repo));
  out(`  ${classCounts(files)}`);
  const next = files.filter((file) => file.class === "CANDIDATE" && !file.scanned).slice(0, limit);
  if (next.length === 0) return out("  No unscanned candidate: the scan is exhausted.") ?? 0;
  for (const file of next) out(`  ${file.density.toFixed(2)}\t${file.branches}\t${file.lines}\t${file.path}`);
  const dir = flagValue(argv, "--out");
  if (dir) for (const path of writeSkeletons(root, { dir, repos, files: next })) out(`  wrote ${path}`);
  return 0;
}

function runInfra(root, { argv, out, config }) {
  const draft = draftInfra(root, { config, scan: scanProject(root, { config, ledger: {} }) });
  const text = `${JSON.stringify(draft, null, 1)}\n`;
  const path = flagValue(argv, "--out");
  if (!path) return out(text) ?? 0;
  const target = scratchTarget(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  out(`${draft.upsert.services.length} service(s), ${draft.upsert.surfaces.length} surface(s) drafted in ${relative(root, target)}. Review the names and kinds, then kiln dna apply it.`);
  return 0;
}

function runBuild(root, out) {
  const plan = applyBatch(root, { batch: {}, today: today() });
  out(`Store derived again: ${plan.gates.warnings.length} warning(s).`);
  return 0;
}

/** `argv` is what followed `kiln dna`. */
export function runDnaCommand(root, { argv, out, config }) {
  const [verb = "status", ...rest] = argv;
  if (verb === "status") return runStatus(root, out);
  if (verb === "check") return runCheck(root, out);
  if (verb === "apply") return runApply(root, { argv: rest, out, config });
  if (verb === "build") return runBuild(root, out);
  if (verb === "scan") return runScan(root, { argv: rest, out, config });
  if (verb === "infra") return runInfra(root, { argv: rest, out, config });
  throw new DnaError(`kiln dna has no verb "${verb}".\n${DNA_USAGE}`);
}
