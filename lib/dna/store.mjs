import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseJsonText } from "../config.mjs";
import { COLLECTIONS, METHODOLOGY_VERSION, SCHEMA_VERSION } from "./contract.mjs";

/**
 * `.kiln/dna/store/` holds the contract's JSONL files and `manifest.json`, plus two of kiln's:
 * `settings.json` — what the source kept beside the store in `dna-store.config.json`,
 * `_infra_map.json`'s `components.custom` and `_actor_registry.json` — and `scan.json`, the
 * blob of every file a scan round read. Keeping them inside means one directory swap replaces
 * all of it, so a store is never derived from settings or a ledger it does not hold.
 */

export class DnaError extends Error {}

export function storeDir(root) {
  return join(root, ".kiln", "dna", "store");
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return parseJsonText(line);
    } catch (error) {
      throw new DnaError(`${path}:${index + 1} is not JSON (${error.message}). The store is written only by \`kiln dna\`; restore it from git.`);
    }
  });
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return parseJsonText(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DnaError(`${path} is not JSON (${error.message}). Restore it from git.`);
  }
}

export function hasStore(root) {
  return existsSync(join(storeDir(root), "manifest.json"));
}

/**
 * A write swaps with two renames. Dying between them leaves only `store.previous`, which is a
 * whole store — the one before the write — so it is put back rather than read as nothing.
 */
function recoverInterruptedWrite(dir) {
  if (!existsSync(dir) && existsSync(`${dir}.previous`)) renameSync(`${dir}.previous`, dir);
}

/** An absent store reads as empty: every collection is optional in the contract. */
export function readStore(root) {
  const dir = storeDir(root);
  recoverInterruptedWrite(dir);
  const data = Object.fromEntries(Object.keys(COLLECTIONS).map((name) => [name, readJsonl(join(dir, `${name}.jsonl`))]));
  const manifest = readJson(join(dir, "manifest.json"));
  if (manifest && manifest.schema_version > SCHEMA_VERSION) {
    throw new DnaError(`.kiln/dna/store has schema_version ${manifest.schema_version}, newer than this kiln understands (${SCHEMA_VERSION}). Update kiln.`);
  }
  return { data, manifest, settings: readJson(join(dir, "settings.json")) ?? {}, scanned: readJson(join(dir, "scan.json"))?.files ?? {}, rounds: readJson(join(dir, "scan.json"))?.rounds ?? [] };
}

export function buildManifest(root, { data, settings, previous, pins = {} }) {
  return {
    schema_version: SCHEMA_VERSION,
    dna_methodology_version: METHODOLOGY_VERSION,
    project: settings.project ?? basename(root),
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    adapter: "kiln",
    source_pins: { ...(previous?.source_pins ?? {}), ...pins },
    counts: Object.fromEntries(Object.keys(COLLECTIONS).map((name) => [name, data[name].length])),
    evidence_sources: settings.evidence_sources ?? [],
    ext_field_labels: settings.ext_field_labels ?? {},
    ...(settings.diagram ? { diagram: settings.diagram } : {}),
  };
}

function writeFiles(dir, { data, settings, manifest, scanned, rounds = [] }) {
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(COLLECTIONS)) {
    writeFileSync(join(dir, `${name}.jsonl`), data[name].map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  }
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 1)}\n`, "utf8");
  const sorted = Object.fromEntries(Object.entries(scanned ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(join(dir, "scan.json"), `${JSON.stringify({ files: sorted, ...(rounds.length > 0 ? { rounds } : {}) }, null, 1)}\n`, "utf8");
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`, "utf8");
}

/**
 * Written beside the store and swapped in whole, so a failed write leaves the previous store
 * in place. The counts are taken again from the files on disk before the swap: that recount is
 * the source's conservation gate, and it is the one check that reads what was written.
 */
export function writeStore(root, store) {
  const dir = storeDir(root);
  const staging = `${dir}.building`;
  const previous = `${dir}.previous`;
  rmSync(staging, { recursive: true, force: true });
  writeFiles(staging, store);
  for (const [name, count] of Object.entries(store.manifest.counts)) {
    const written = readJsonl(join(staging, `${name}.jsonl`)).length;
    if (written !== count) throw new DnaError(`recount of ${name}: wrote ${written}, expected ${count}. The store was left as it was.`);
  }
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(dir)) renameSync(dir, previous);
  renameSync(staging, dir);
  rmSync(previous, { recursive: true, force: true });
}
