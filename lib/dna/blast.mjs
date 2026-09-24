import { join } from "node:path";
import { workingBlob } from "./scan.mjs";

/**
 * Knowledge tier 1's blast radius (D154): the files the store's evidence says the named terms
 * live in. A term reaches a file two ways — a finding whose proposition names it, or a feature
 * whose name or description does, which brings every file its findings cite. The second is what
 * a grep cannot do: "refund" finds `src/billing/credit.js` through the feature that owns it,
 * though the word never appears there.
 *
 * Verify before use (the Copilot Memory rule): a file whose blob changed since the store read it
 * is still named, marked `changed`, and a file that is gone is marked `gone` — the store's claim
 * about it is older than the code.
 */

function matcher(terms) {
  const patterns = terms.filter(Boolean).map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  return (text) => patterns.filter((pattern) => pattern.test(text)).length;
}

function featureText(feature) {
  return [feature.name, feature.description, ...Object.values(feature.business_description ?? {})].filter(Boolean).join(" ");
}

function credit(score, { finding, count, feature }) {
  const entry = score.get(finding.id) ?? { finding, count: 0, features: new Set() };
  entry.count = Math.max(entry.count, count);
  if (feature) entry.features.add(feature);
  score.set(finding.id, entry);
}

/** Each finding the terms reach, directly or through its feature, with how many terms reached it. */
function reached(store, hits) {
  const retired = new Set(store.data.excluded.filter((entry) => entry.catalog === "RETIRED").flatMap((entry) => entry.rd_ids ?? []));
  const live = store.data.findings.filter((finding) => !retired.has(finding.id));
  const byId = new Map(live.map((finding) => [finding.id, finding]));
  const score = new Map();
  for (const finding of live) {
    const count = hits(finding.proposition ?? "");
    if (count > 0) credit(score, { finding, count, feature: finding.feature_id });
  }
  for (const feature of store.data.features) {
    const count = hits(featureText(feature));
    const owned = count > 0 ? (feature.rd_ids ?? []).filter((id) => byId.has(id)) : [];
    for (const id of owned) credit(score, { finding: byId.get(id), count, feature: feature.id });
  }
  return [...score.values()];
}

function freshness(root, { path, store }) {
  const now = workingBlob(join(root, path));
  if (now === null) return "gone";
  return store.scanned[path] && store.scanned[path] !== now ? "changed" : "current";
}

/** Rows ranked like tier 0's: `{ path, hits, features, findings, freshness }`. */
export function dnaBlastRadius(root, { store, terms }) {
  const rows = new Map();
  for (const { finding, count, features } of reached(store, matcher(terms))) {
    if (!finding.module) continue;
    const row = rows.get(finding.module) ?? { path: finding.module, hits: 0, features: new Set(), findings: [] };
    row.hits = Math.max(row.hits, count);
    for (const feature of features) if (feature) row.features.add(feature);
    row.findings.push(finding.id);
    rows.set(finding.module, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, features: [...row.features].sort(), freshness: freshness(root, { path: row.path, store }) }))
    .sort((a, b) => b.hits - a.hits || b.findings.length - a.findings.length || (a.path < b.path ? -1 : 1));
}
