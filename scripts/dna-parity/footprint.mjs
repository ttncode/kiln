// Writes one generated store for context_footprint.py and prints kiln's own footprint of every
// feature in it, so compare-footprint.py can diff the two. Seeded, so a failing seed replays.
//
// Usage: node footprint.mjs <out-dir> <seed>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTIONS, canonical } from "../../lib/dna/contract.mjs";
import { derive } from "../../lib/dna/derive.mjs";
import { contextFootprint } from "../../lib/dna/footprint.mjs";

const [outDir, seedText] = process.argv.slice(2);
let seed = Number(seedText);
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (values) => values[Math.floor(random() * values.length)];
const FILES = Array.from({ length: 12 }, (_, index) => `src/f${index}.js`);
const LOCATORS = [() => `L${Math.floor(random() * 300)}-${Math.floor(random() * 300)}`, () => `lines ${Math.floor(random() * 300)}-${Math.floor(random() * 300)}`, () => `line ${Math.floor(random() * 300)}`, () => "no locator"];

function store() {
  const data = Object.fromEntries(Object.keys(COLLECTIONS).map((name) => [name, []]));
  const featureIds = Array.from({ length: 3 + Math.floor(random() * 10) }, (_, index) => `DOM-AB-01-${String(index + 1).padStart(2, "0")}`);
  data.findings = Array.from({ length: 10 + Math.floor(random() * 40) }, (_, index) => canonical("finding", { id: `RD-${String(index + 1).padStart(4, "0")}`, module: pick(FILES), evidence: pick(LOCATORS)() }));
  data.features = featureIds.map((id) => canonical("feature", { id, capability_id: "DOM-AB-01", rd_ids: data.findings.filter(() => random() < 1 / featureIds.length).map((finding) => finding.id) }));
  const processes = Array.from({ length: 4 }, (_, index) => `BF-01.S${1 + (index % 2)}.P${index + 1}`);
  data.edges = featureIds.flatMap((feature) => processes.filter(() => random() < 0.3).map((process) => ({ entity: "edge", from: process, to: feature, kind: "FEATURE_PROCESS" })));
  data.edges.push(...processes.filter(() => random() < 0.5).map((process) => ({ entity: "edge", from: process, to: pick(["DOM-AB-02", "DOM-AB-03"]), kind: "TYPED_REL", type: pick(["USES_DATA_FROM", "TRIGGERS"]) })));
  return derive(data, {});
}

const data = store();
mkdirSync(join(outDir, "_dna_store"), { recursive: true });
for (const name of Object.keys(COLLECTIONS)) writeFileSync(join(outDir, "_dna_store", `${name}.jsonl`), data[name].map((record) => `${JSON.stringify(record)}\n`).join(""));
process.stdout.write(JSON.stringify(contextFootprint({ data }, data.features.map((feature) => feature.id))));
