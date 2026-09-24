// Writes one generated store, derived by kiln, for compare.py to derive again with the
// Python originals. Seeded, so a failing seed can be replayed.
//
// Usage: node generate.mjs <out-dir> <seed>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTIONS, canonical } from "../../lib/dna/contract.mjs";
import { derive } from "../../lib/dna/derive.mjs";

const SEGMENTS = ["addons", "web", "website_sale", "odoo", "models", "src", "api", "billing", "bill", "report", "x.py", "y.js"];
const [outDir, seedText] = process.argv.slice(2);

let seed = Number(seedText);
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function pick(values) {
  return values[Math.floor(random() * values.length)];
}

function path() {
  return Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(SEGMENTS)).join("/");
}

function times(limit, make) {
  return Array.from({ length: Math.floor(random() * limit) }, (_, index) => make(index));
}

function services() {
  return times(4, (index) => canonical("service", {
    id: `SVC-S${index}`,
    kind: pick(["BACKEND", "EXTERNAL", "FRONTEND"]),
    root_paths: random() < 0.6 ? [path(), ...(random() < 0.3 ? [`${path()}/`] : [])] : [],
    module_keywords: random() < 0.5 ? [pick(SEGMENTS)] : [],
  })).concat(canonical("service", { id: "SVC-LAST", kind: "BACKEND", root_paths: [path()] }));
}

function store() {
  const data = Object.fromEntries(Object.keys(COLLECTIONS).map((name) => [name, []]));
  data.services = services();
  data.surfaces = times(4, (index) => canonical("surface", { id: `SRF-U${index}`, kind: "API", primary_paths: [path()], ...(random() < 0.3 ? { match: { module_prefixes: [path()] } } : {}) }));
  data.findings = times(20, (index) => canonical("finding", { id: `RD-${String(index + 1).padStart(4, "0")}`, module: random() < 0.9 ? path() : undefined }));
  data.features = [canonical("feature", { id: "DOM-AB-01-01", capability_id: "DOM-AB-01", rd_ids: data.findings.filter(() => random() < 0.4).map((finding) => finding.id) })];
  data.excluded = [canonical("excluded", { id: "EXC-1", rd_ids: data.findings.filter(() => random() < 0.3).map((finding) => finding.id) })];
  data.edges = times(6, () => ({ entity: "edge", from: "BF-01.S1.P1", to: pick(data.services).id, kind: "EXTERNAL_HOP", channel: pick(["http", "mail"]), evidence: `${path()}:${Math.floor(random() * 99)}` }));
  if (random() < 0.5) data.edges.push({ entity: "edge", from: pick(data.services).id, to: pick(data.services).id, kind: "TOPOLOGY", type: "CALLS" });
  return data;
}

const settings = { components: { custom: random() < 0.5 ? ["web", "billing"] : [] } };
const derived = derive(store(), settings);
mkdirSync(outDir, { recursive: true });
for (const name of Object.keys(COLLECTIONS)) writeFileSync(join(outDir, `${name}.jsonl`), derived[name].map((record) => `${JSON.stringify(record)}\n`).join(""));
writeFileSync(join(outDir, "settings.json"), JSON.stringify(settings));
