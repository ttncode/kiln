// Writes a roster and 2–4 random panel manifests for reconcile_5a.py, then prints kiln's own
// reconciliation of them as JSON, so compare-reconcile.py can diff the two. Seeded.
//
// Usage: node reconcile.mjs <out-dir> <seed>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, reconcilePanels } from "../../lib/dna/reconcile.mjs";

const [outDir, seedText] = process.argv.slice(2);
let seed = Number(seedText);
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

const roster = Array.from({ length: 6 + Math.floor(random() * 20) }, (_, index) => `P${String(index + 1).padStart(3, "0")}`);
const panelCount = 2 + Math.floor(random() * 3);
const flowCount = 2 + Math.floor(random() * 4);

function manifest(tag) {
  const flows = Array.from({ length: flowCount }, (_, index) => ({ id: `BF-${String(index + 1).padStart(2, "0")}`, name: `Journey ${index + 1}${tag}`, verdict: ["crosses", "gap", "demote"][Math.floor(random() * 3)], stages: [{ name: "S1", processes: [] }] }));
  for (const id of roster) if (random() > 0.08) flows[Math.floor(random() * flowCount)].stages[0].processes.push(id);
  return { panel: tag, flows };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "roster.json"), JSON.stringify(roster));
const manifests = Array.from({ length: panelCount }, (_, index) => manifest("GHIJ"[index]));
manifests.forEach((each) => writeFileSync(join(outDir, `manifest_${each.panel}.json`), JSON.stringify(each)));
const result = reconcilePanels(manifests.map((each) => readManifest(each, each.panel)), { minAgree: Math.floor(panelCount / 2) + 1, roster });
process.stdout.write(JSON.stringify(result));
