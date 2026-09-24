/**
 * The context footprint of a feature, ported from tps-project-dna's `context_footprint.py`
 * (schema 3, D165): how much context working on it correctly takes, counted, never estimated —
 * its rules, its evidence files, its processes, and three channels of neighbours, each saying why
 * it is one, because each asks for a different check when the feature changes:
 *
 *   SHARES_FILE     another feature citing one of the same files — per-feature regression
 *   SHARES_STAGE    another feature on the same stage (same_process when the very process)
 *   REL_CAPABILITY  a capability this feature's processes relate to by a typed edge
 *
 * Feature-level neighbours carry a tier: STRONG when their evidence line ranges overlap or sit
 * within PROX_GAP lines in one file, MEDIUM for the same non-hub file or the same process, WEAK
 * for a hub file (cited by HUB_THRESHOLD or more features) or a shared stage alone.
 */

const SAMPLE_FILES_CAP = 3;
const HUB_THRESHOLD = 8;
const PROX_GAP = 50;
const STAGE = /^(.+\.S\d+)\.P\d+$/;
const RANK = { STRONG: 0, MEDIUM: 1, WEAK: 2 };

// The source's locator families, first family that matches wins. The second also takes `L3-L12`,
// which is how kiln's scanner writes a range; the source's pattern read it as two single lines.
const LINE_RANGES = [/lines?\s+(\d+)\s*[-–]\s*(\d+)/gi, /\bL(\d+)\s*[-–]\s*L?(\d+)\b/g, /\bline\s+(\d+)\b/gi, /\bL(\d+)\b/g];

function locatorText(evidence) {
  if (evidence === null || evidence === undefined) return "";
  if (typeof evidence === "string") return evidence;
  if (Array.isArray(evidence)) return evidence.map(locatorText).join(" ");
  if (typeof evidence === "object") return Object.values(evidence).map(locatorText).join(" ");
  return String(evidence);
}

/** Best effort: evidence with no locator contributes no range, and proximity reads as unknown. */
export function lineRanges(evidence) {
  const text = locatorText(evidence);
  for (const pattern of LINE_RANGES) {
    const ranges = [...text.matchAll(pattern)].map((match) => {
      const low = Number(match[1]);
      const high = match[2] ? Number(match[2]) : low;
      return high < low ? [high, low] : [low, high];
    });
    if (ranges.length > 0) return ranges;
  }
  return [];
}

/** The smallest line gap between two sets of ranges: 0 when they overlap, null when either is unknown. */
export function rangeGap(first, second) {
  if (!first?.length || !second?.length) return null;
  let best = null;
  for (const [lowA, highA] of first) {
    for (const [lowB, highB] of second) {
      if (highA >= lowB && highB >= lowA) return 0;
      const gap = Math.min(Math.abs(lowB - highA), Math.abs(lowA - highB));
      best = best === null ? gap : Math.min(best, gap);
    }
  }
  return best;
}

function addTo(map, { key, value }) {
  map.set(key, new Set([...(map.get(key) ?? []), value]));
}

/** One pass over findings: rules and files per feature, features per file, ranges per (feature, file). */
function findingIndexes(findings) {
  const index = { rules: new Map(), files: new Map(), featuresOfFile: new Map(), ranges: new Map() };
  for (const finding of findings.filter((each) => each.feature_id)) {
    const feature = finding.feature_id;
    index.rules.set(feature, (index.rules.get(feature) ?? 0) + 1);
    if (!finding.module) continue;
    addTo(index.files, { key: feature, value: finding.module });
    addTo(index.featuresOfFile, { key: finding.module, value: feature });
    const ranges = lineRanges(finding.evidence);
    const key = `${feature}\u0000${finding.module}`;
    if (ranges.length > 0) index.ranges.set(key, [...(index.ranges.get(key) ?? []), ...ranges]);
  }
  return index;
}

function edgeIndexes(edges, features) {
  const index = { featuresOfProcess: new Map(), processesOfFeature: new Map(), relations: new Map() };
  for (const edge of edges) {
    if (edge.kind === "FEATURE_PROCESS") {
      const [process, feature] = features.has(edge.to) ? [edge.from, edge.to] : [edge.to, edge.from];
      if (!features.has(feature)) continue;
      addTo(index.featuresOfProcess, { key: process, value: feature });
      addTo(index.processesOfFeature, { key: feature, value: process });
    } else if (edge.kind === "TYPED_REL") {
      const byCapability = index.relations.get(edge.from) ?? new Map();
      addTo(byCapability, { key: edge.to, value: edge.type });
      index.relations.set(edge.from, byCapability);
    }
  }
  return index;
}

/** The closest the two features' evidence comes in any file they share, where both give line ranges. */
function closest(target, { other, shared, found }) {
  let best = { gap: null, path: null };
  for (const path of shared) {
    const gap = rangeGap(found.ranges.get(`${target}\u0000${path}`), found.ranges.get(`${other}\u0000${path}`));
    if (gap !== null && (best.gap === null || gap < best.gap)) best = { gap, path };
  }
  return best;
}

function fileTier(target, { other, shared, found }) {
  const best = closest(target, { other, shared, found });
  const hubs = shared.filter((path) => (found.featuresOfFile.get(path)?.size ?? 0) >= HUB_THRESHOLD);
  const plain = shared.filter((path) => !hubs.includes(path));
  if (best.gap !== null && best.gap <= PROX_GAP) return { tier: "STRONG", tier_reason: best.gap === 0 ? `evidence line-ranges overlap in ${best.path}` : `evidence line-ranges within ${best.gap} lines in ${best.path}` };
  if (plain.length > 0) return { tier: "MEDIUM", tier_reason: `same non-hub file (${plain[0]}), proximity ${best.gap === null ? "unknown" : "far"}` };
  return { tier: "WEAK", tier_reason: hubs.length > 0 ? `only via hub file(s) shared by >= ${HUB_THRESHOLD} features (${hubs[0]} …)` : "shared file, weak signal" };
}

function sharesFile(target, found) {
  const files = [...(found.files.get(target) ?? [])];
  const others = new Map();
  // Sorted, so the sample and the example file a reason names are the same on every run; the
  // source takes them in Python set order, which changes with the interpreter's hash seed.
  for (const path of files.sort()) for (const other of found.featuresOfFile.get(path) ?? []) if (other !== target) others.set(other, [...(others.get(other) ?? []), path]);
  return [...others]
    .sort(([a, pathsA], [b, pathsB]) => pathsB.length - pathsA.length || (a < b ? -1 : 1))
    .map(([other, shared]) => ({ id: other, shared_files: shared.length, sample: shared.slice(0, SAMPLE_FILES_CAP), ...fileTier(target, { other, shared, found }) }));
}

function stageOf(process) {
  return STAGE.exec(process)?.[1];
}

function sharesStage(target, { linked, processes }) {
  const sameProcess = new Set(processes.flatMap((process) => [...(linked.featuresOfProcess.get(process) ?? [])]));
  const stages = new Set(processes.map(stageOf).filter(Boolean));
  const entries = new Map();
  for (const [process, features] of linked.featuresOfProcess) {
    if (!stages.has(stageOf(process))) continue;
    for (const other of [...features].filter((each) => each !== target)) {
      const entry = entries.get(other) ?? { stages: new Set(), same_process: false };
      entry.stages.add(stageOf(process));
      entry.same_process ||= sameProcess.has(other);
      entries.set(other, entry);
    }
  }
  return [...entries]
    .sort(([a, x], [b, y]) => Number(y.same_process) - Number(x.same_process) || (a < b ? -1 : 1))
    .map(([id, entry]) => ({ id, stage: [...entry.stages].sort(), same_process: entry.same_process, tier: entry.same_process ? "MEDIUM" : "WEAK", tier_reason: entry.same_process ? "same Process" : "same Stage only" }));
}

function relCapability(processes, linked) {
  const byCapability = new Map();
  const pairs = processes.flatMap((process) => [...(linked.relations.get(process) ?? [])]);
  for (const [capability, types] of pairs) for (const type of [...types].filter(Boolean)) addTo(byCapability, { key: capability, value: type });
  return [...byCapability].sort(([a], [b]) => (a < b ? -1 : 1)).map(([capability, types]) => ({ capability, types: [...types].sort() }));
}

function tierCounts(neighbours) {
  const best = new Map();
  for (const entry of neighbours) if (!best.has(entry.id) || RANK[entry.tier] < RANK[best.get(entry.id)]) best.set(entry.id, entry.tier);
  const counts = { strong: 0, medium: 0, weak: 0 };
  for (const tier of best.values()) counts[tier.toLowerCase()] += 1;
  return counts;
}

function footprintOf(target, { store, found, linked }) {
  const processes = [...(linked.processesOfFeature.get(target) ?? [])].sort();
  const file = sharesFile(target, found);
  const stage = sharesStage(target, { linked, processes });
  const related = relCapability(processes, linked);
  return {
    schema: 3,
    rules: found.rules.get(target) ?? 0,
    evidence_files: found.files.get(target)?.size ?? 0,
    processes,
    neighbors: { SHARES_FILE: file, SHARES_STAGE: stage, REL_CAPABILITY: related },
    neighbor_count: { SHARES_FILE: file.length, SHARES_STAGE: stage.length, REL_CAPABILITY: related.length, distinct_features: new Set([...file, ...stage].map((entry) => entry.id)).size },
    neighbor_tiers: tierCounts([...file, ...stage]),
    status: store.data.features.find((feature) => feature.id === target).status ?? null,
  };
}

/** `targets`: feature ids, or the string "--all-planned". Unknown ids are an error, not an empty answer. */
export function contextFootprint(store, targets) {
  const features = new Set(store.data.features.map((feature) => feature.id));
  const ids = targets === "--all-planned" ? store.data.features.filter((feature) => feature.status === "PLANNED").map((feature) => feature.id).sort() : targets;
  const unknown = ids.filter((id) => !features.has(id));
  if (unknown.length > 0) throw new Error(`unknown feature id(s): ${unknown.join(", ")}`);
  const found = findingIndexes(store.data.findings);
  const linked = edgeIndexes(store.data.edges, features);
  return Object.fromEntries(ids.map((id) => [id, footprintOf(id, { store, found, linked })]));
}
