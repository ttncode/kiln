import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseJsonText } from "../config.mjs";
import { isInside } from "../paths.mjs";
import { applyBatch, checkStore, remapPlan } from "./apply.mjs";
import { checkpointInfo, restoreCheckpoint } from "./checkpoint.mjs";
import { renderGates } from "./gates.mjs";
import { citing, driftVerdict, measureDrift } from "./drift.mjs";
import { contextFootprint } from "./footprint.mjs";
import { draftInfra } from "./infra.mjs";
import { parseRoster, readManifest, reconcilePanels, renderReconciliation } from "./reconcile.mjs";
import { serveExplorer } from "./serve.mjs";
import { sizeLines } from "./size.mjs";
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

  kiln dna drift
      Fetch the integration branch, then say how far the code has moved from what the
      store read: changed, new and deleted files, the findings each one puts in doubt,
      and whether that is none, small, large, or unknown because the fetch failed.

  kiln dna update [--limit <n>] [--out <dir under .kiln/tmp>]
      The same measurement, and with --out a batch skeleton per group of changed and
      new files; a changed file carries the blob it was read at and the findings that
      cite it. Refused on a store with no findings: that is kiln dna init's work.

  kiln dna infra [--out <file under .kiln/tmp>]
      Draft the store's services and surfaces as a batch, for a person to review
      before it is applied: a service per repository or top-level code directory
      and per database/cache/queue image a compose file names, a surface per file
      the stack's dna.surfaces rules match. Writes nothing to the store.

  kiln dna serve [--port <n>]
      Serve the store explorer on 127.0.0.1 and print its address, which carries a
      token no other page can guess. Read-only; stops after two hours unused.

  kiln dna remap <plan.json> [--apply]
      Restructure: move capabilities or features, split or delete them, re-lay a
      flow's stages, renumber flows. Every id beneath a moved node and every reference
      to it follows; moved records keep their old ids as history. Without --apply it
      prints the id changes and writes nothing.

  kiln dna footprint <feature-id ...> | --all-planned
      The context working on a feature takes, counted: its rules, files and processes,
      and the features that share a file (STRONG / MEDIUM / WEAK), a stage, or a typed
      relation with it — what a change to it puts at risk.

  kiln dna reconcile <manifest.json ...> [--roster <file>] [--min-agree <n>] [--out <file>]
      Phase 5a panels, reconciled: the processes the panels agree on grouping, the
      clusters they disagree on (escalate each to someone who reads the reasoning), and
      any roster process a panel — or every panel — dropped.

  kiln dna restore
      Put the store back from this project's last checkpoint (under refs/worktree/kiln/) when the
      working tree has lost it. Never overwrites a store that is there.

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

function checkpointLine(saved) {
  return saved.commit ? `Checkpoint: ${saved.commit.slice(0, 12)}.` : `No checkpoint was taken (${saved.error}). The store on disk is written; a wiped working tree could not be restored from it.`;
}

function noStore(root, out) {
  const saved = checkpointInfo(root);
  if (!saved) return out("No DNA store in this project yet (.kiln/dna/store/).") ?? 0;
  out(`No DNA store in the working tree, but a checkpoint of one exists (${saved.commit.slice(0, 12)}, ${saved.date}).`);
  return out("It is put back by `kiln dna restore`.") ?? 0;
}

function runStatus(root, out) {
  if (!hasStore(root)) return noStore(root, out);
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
  out(checkpointLine(plan.checkpoint));
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

/**
 * A draft is scratch, so it goes under `.kiln/tmp/`, resolved from the project root rather than
 * the shell's directory. Compared by real path: a symlink inside `.kiln/tmp/` that leads out of
 * it is outside.
 */
function scratchTarget(root, path) {
  const scratch = join(root, ".kiln", "tmp");
  const target = resolve(root, path);
  mkdirSync(scratch, { recursive: true });
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, target));
  if (!isInside(realpathSync(scratch), real)) throw new DnaError(`--out must be under ${scratch}: drafts are scratch.`);
  return real;
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

function limitOf(argv) {
  const limit = Number(flagValue(argv, "--limit") ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) throw new DnaError("--limit takes a whole number of files, 1 or more.");
  return limit;
}

function runScan(root, { argv, out, config }) {
  const limit = limitOf(argv);
  const store = readStore(root);
  const { repos, files } = scanProject(root, { config, ledger: store.scanned });
  for (const repo of repos) out(repoLine(repo));
  out(`  ${classCounts(files)}`);
  const unscanned = files.filter((file) => file.class === "CANDIDATE" && !file.scanned);
  for (const line of sizeLines(unscanned, store.data.updates)) out(`  ${line}`);
  const next = unscanned.slice(0, limit);
  if (next.length < unscanned.length) out(`  this run takes ${next.length} of them (--limit ${limit}): ${sizeLines(next, store.data.updates)[0]}`);
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

const VERDICTS = {
  none: "none: the store describes the integration branch as it is",
  small: "small: catch up now — offered, default yes (D22)",
  large: "large: use the store with the drifted files marked low-confidence, and offer to catch up, default no (D22)",
  unknown: "unknown: a fetch failed, so the numbers are as old as the last fetch; treat the whole store as low-confidence and offer to catch up, default no (D82)",
};

function withCitations(paths, findings) {
  return paths.map((path) => {
    const ids = citing(findings, [path]).map((finding) => finding.id);
    return ids.length > 0 ? `${path} (${ids.join(", ")})` : path;
  });
}

function printDrift(out, { drift, store }) {
  const pins = store.manifest?.source_pins ?? {};
  for (const repo of drift.repos) out(`${repoLine(repo)}${pins[repo.name] ? ` · pinned ${pins[repo.name].slice(0, 12)}` : " · never pinned"}`);
  for (const failure of drift.unfetched) out(`  ${failure}`);
  const verdict = driftVerdict(drift);
  const counted = `${drift.changed.length} changed · ${drift.added.length} new candidate(s) · ${drift.deleted.length} deleted`;
  out(`  ${verdict.level === "unknown" ? `as of the last fetch, ${counted}` : counted} — ${VERDICTS[verdict.level]}`);
  if (drift.unread.length > 0) out(`  ${drift.unread.length} candidate(s) the bootstrap has not read yet — not drift; /kiln dna init continues it`);
  const lines = [["changed", withCitations(drift.changed.map((file) => file.path), store.data.findings)], ["new", drift.added.map((file) => file.path)], ["deleted", withCitations(drift.deleted, store.data.findings)]];
  for (const [label, paths] of lines) for (const path of paths.slice(0, DEFAULT_LIMIT)) out(`  ${label}: ${path}`);
  return verdict;
}

function runDrift(root, { out, config }) {
  if (!hasStore(root)) return out("No DNA store in this project yet (.kiln/dna/store/).") ?? 0;
  const store = readStore(root);
  printDrift(out, { drift: measureDrift(root, { config, store }), store });
  return 0;
}

/** A changed file's skeleton says what it was, so the scanner reads the diff and the findings it touches. */
function enrich(skeleton, { store }) {
  const read = skeleton.read.map((entry) => {
    const was = store.scanned[entry.path];
    const cites = citing(store.data.findings, [entry.path]).map((finding) => finding.id);
    return was ? { ...entry, was, cites } : entry;
  });
  return { ...skeleton, read };
}

function runUpdate(root, { argv, out, config }) {
  const store = readStore(root);
  if (store.data.findings.length === 0) throw new DnaError("The store has no findings, so there is nothing to catch up: a first build is /kiln dna init (D79).");
  const limit = limitOf(argv);
  const drift = measureDrift(root, { config, store });
  printDrift(out, { drift, store });
  for (const line of sizeLines([...drift.changed, ...drift.added], store.data.updates)) out(`  ${line}`);
  const dir = flagValue(argv, "--out");
  if (!dir) return 0;
  const target = scratchTarget(root, dir);
  mkdirSync(target, { recursive: true });
  const files = [...drift.changed, ...drift.added].slice(0, limit);
  skeletons(root, { repos: drift.repos, groups: groupFiles(files) }).forEach((skeleton, index) => {
    const path = join(target, `update-${String(index + 1).padStart(3, "0")}.json`);
    writeFileSync(path, `${JSON.stringify(enrich(skeleton, { store }), null, 1)}\n`);
    out(`  wrote ${relative(root, path)}`);
  });
  return 0;
}

/** Resolves with the exit code when the server closes; until then the process keeps serving. */
async function runServe(root, { argv, out }) {
  if (!hasStore(root)) throw new DnaError("No DNA store to show yet (.kiln/dna/store/).");
  const port = Number(flagValue(argv, "--port") ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DnaError("--port takes a port number.");
  const { url, server } = await serveExplorer(root, { port }).catch((error) => {
    throw error.code === "EADDRINUSE" ? new DnaError(`port ${port} is in use: pick another with --port, or leave it out and kiln picks a free one.`) : error;
  });
  out(`DNA explorer: ${url}\nRead-only, on this machine only; it stops after two hours with no request, or on Ctrl+C.`);
  await new Promise((resolve) => server.on("close", resolve));
  return 0;
}

function runBuild(root, out) {
  const plan = applyBatch(root, { batch: {}, today: today() });
  out(`Store derived again: ${plan.gates.warnings.length} warning(s).`);
  return 0;
}

function runFootprint(root, { argv, out }) {
  if (argv.length === 0) throw new DnaError("kiln dna footprint needs feature ids, or --all-planned.");
  const store = readStore(root);
  try {
    return out(JSON.stringify(contextFootprint(store, argv.includes("--all-planned") ? "--all-planned" : argv), null, 2)) ?? 0;
  } catch (error) {
    throw new DnaError(error.message);
  }
}

function readText(path) {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch (error) {
    throw new DnaError(`${path} could not be read: ${error.message}`);
  }
}

function runReconcile(root, { argv, out }) {
  const valued = ["--roster", "--min-agree", "--out"];
  const manifests = argv.filter((arg, index) => !arg.startsWith("--") && !valued.includes(argv[index - 1]));
  if (manifests.length < 2) throw new DnaError("kiln dna reconcile needs two or more panel manifests.");
  const panels = manifests.map((path) => readManifest(readBatch(path), path.split("/").pop().replace(/\.json$/, "")));
  const given = flagValue(argv, "--min-agree");
  if (given !== undefined && !/^\d+$/.test(given)) throw new DnaError("--min-agree takes a whole number of panels.");
  // 0 or absent is the majority, as in the source.
  const minAgree = Number(given ?? 0) || Math.floor(panels.length / 2) + 1;
  const rosterPath = flagValue(argv, "--roster");
  const result = reconcilePanels(panels, { minAgree, roster: rosterPath ? parseRoster(readText(rosterPath)) : null });
  out(renderReconciliation(result));
  const target = flagValue(argv, "--out");
  if (target) writeFileSync(scratchTarget(root, target), `${JSON.stringify(result, null, 1)}\n`);
  return 0;
}

function runRemap(root, { argv, out }) {
  const path = argv.find((arg) => !arg.startsWith("--"));
  if (!path) throw new DnaError("kiln dna remap needs a plan file: kiln dna remap <plan.json> [--apply]");
  const result = remapPlan(root, { plan: readBatch(path), apply: argv.includes("--apply") });
  for (const [from, to] of result.changed) out(`  ${from} → ${to}`);
  if (!result.written) return out(`${result.changed.size} id(s) would change and every gate passes. Nothing written; run again with --apply.`) ?? 0;
  out(`Remapped: ${result.changed.size} id(s) changed; every reference follows, and each moved record keeps its old id as history.`);
  out(checkpointLine(result.checkpoint));
  return 0;
}

const VERBS = {
  status: (root, { out }) => runStatus(root, out),
  check: (root, { out }) => runCheck(root, out),
  build: (root, { out }) => runBuild(root, out),
  apply: runApply,
  scan: runScan,
  infra: runInfra,
  drift: runDrift,
  update: runUpdate,
  serve: runServe,
  remap: runRemap,
  footprint: runFootprint,
  reconcile: runReconcile,
  restore: (root, { out }) => out(`Store restored from checkpoint ${restoreCheckpoint(root).slice(0, 12)}. Run kiln dna check.`) ?? 0,
};

/** `argv` is what followed `kiln dna`. */
export function runDnaCommand(root, { argv, out, config }) {
  const [verb = "status", ...rest] = argv;
  if (!Object.hasOwn(VERBS, verb)) throw new DnaError(`kiln dna has no verb "${verb}".\n${DNA_USAGE}`);
  return VERBS[verb](root, { argv: rest, out, config });
}
