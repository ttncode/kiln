import { DnaError } from "./store.mjs";

/**
 * Restructuring, ported from tps-project-dna's `apply_taxonomy_split.py` and the `apply` step of
 * `apply_stage_layout.py` (D164). Both exist because ids encode their parent — `DOM-X-NN-YY`,
 * `BF-NN.S#.P#` — so moving one node renumbers every node beneath it and every reference to any
 * of them, and doing that by hand is how the source's own rounds left dangling ids behind. The
 * plan is judgement a person approved; this executes it and decides nothing.
 *
 * Plan: the source's taxonomy schema (`new_domains`, `new_capabilities`, `capability_moves`,
 * `feature_moves`, `deletes`, `restatements`) plus `stage_layouts` — `{ "<flow>": { "stages": [
 * { name, entry, exit, processes: [...], gap, note } ] } }` — and `renumber_flows`.
 */

const HISTORY = /^(?:legacy_|previous_)|^(?:id_history|merged_from|split_from|moved_from_stage|retired_by|added_by)$/;
const CAPABILITY_ID = /\bDOM-[A-Z]+-\d{2,}(?:-\d{2,})?\b/g;

function fail(message) {
  throw new DnaError(`remap refused, nothing written: ${message}`);
}

function byParent(rows, key) {
  const groups = new Map();
  for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
  return groups;
}

function pad(number) {
  return String(number).padStart(2, "0");
}

/** The capability axis as ordered lists — domains, their capabilities, their features — in store order. */
function capabilityTree(data) {
  const features = byParent(data.features, "capability_id");
  const capabilities = byParent(data.capabilities, "domain_id");
  return data.domains.map((domain) => ({ ...domain, capabilities: (capabilities.get(domain.id) ?? []).map((capability) => ({ ...capability, features: [...(features.get(capability.id) ?? [])] })) }));
}

function findCapability(tree, id) {
  for (const domain of tree) {
    const capability = domain.capabilities.find((each) => each.id === id);
    if (capability) return { domain, capability };
  }
  return null;
}

function detachCapability(tree, { id, moved }) {
  const found = findCapability(tree, id) ?? fail(`capability ${id} not found`);
  if (moved.has(id)) fail(`capability ${id} moved twice`);
  moved.add(id);
  found.domain.capabilities = found.domain.capabilities.filter((each) => each !== found.capability);
  return found;
}

function domainOf(tree, id) {
  return tree.find((domain) => domain.id === id) ?? fail(`domain ${id} not found`);
}

function addDomains(tree, { plan, moved }) {
  for (const draft of plan.new_domains ?? []) {
    if (tree.some((domain) => domain.id === draft.id)) fail(`new domain ${draft.id} already exists`);
    const taken = (draft.from_capabilities ?? []).map((id) => detachCapability(tree, { id, moved }));
    const { from_capabilities, ...fields } = draft;
    tree.push({ ...fields, entity: "domain", split_from: [...new Set(taken.map((each) => each.domain.id))].sort(), capabilities: taken.map((each) => each.capability) });
  }
  for (const move of plan.capability_moves ?? []) {
    const { capability } = detachCapability(tree, { id: move.capability, moved });
    domainOf(tree, move.target_domain).capabilities.push(capability);
  }
}

function detachFeature(tree, id) {
  for (const domain of tree) {
    for (const capability of domain.capabilities) {
      const feature = capability.features.find((each) => each.id === id);
      if (feature) {
        capability.features = capability.features.filter((each) => each !== feature);
        return feature;
      }
    }
  }
  return fail(`feature ${id} not found`);
}

/** A capability minted for a feature-level split must hold at least one feature: the identity litmus rejects an empty ability. */
function addCapabilities(tree, plan) {
  (plan.new_capabilities ?? []).forEach((draft, index) => {
    const domain = domainOf(tree, draft.domain);
    const features = (draft.from_features ?? []).map((id) => detachFeature(tree, id));
    if (features.length === 0) fail(`new capability ${draft.name} has no features`);
    const { domain: _, from_features, ...fields } = draft;
    domain.capabilities.push({ ...fields, entity: "capability", id: `${draft.domain}-NEW${pad(index + 1)}`, features });
  });
  for (const move of plan.feature_moves ?? []) {
    const feature = detachFeature(tree, move.feature);
    (findCapability(tree, move.target_capability) ?? fail(`target capability ${move.target_capability} not found`)).capability.features.push(feature);
  }
}

function deleteAndRestate(tree, plan) {
  for (const doomed of plan.deletes ?? []) {
    const found = findCapability(tree, doomed.capability) ?? fail(`capability ${doomed.capability} not found`);
    found.domain.capabilities = found.domain.capabilities.filter((each) => each !== found.capability);
  }
  restate(tree, plan);
}

/**
 * Judged on the store as it was, before any move in the plan — the source's validation pass
 * does the same, so a plan cannot empty a capability and delete it in one step.
 */
function checkDeletes(data, plan) {
  for (const doomed of plan.deletes ?? []) {
    const features = data.features.filter((feature) => feature.capability_id === doomed.capability).length;
    if (features > 0) fail(`${doomed.capability} is not empty (${features} features): a non-empty node is a move, not a delete`);
  }
}

/**
 * A deleted id is in no old-to-new map, and renumbering hands its number to the next
 * capability — so anything still naming it would quietly name that one instead. The source
 * has the same hole; here it is refused.
 */
function checkDanglingDeletes(data, plan) {
  const deleted = new Set((plan.deletes ?? []).map((doomed) => doomed.capability));
  if (deleted.size === 0) return;
  const citing = Object.entries(data).flatMap(([name, rows]) => rows.filter((row) => row.id && !deleted.has(row.id) && citesAny(row, { ids: deleted })).map((row) => `${name}:${row.id ?? `${row.from}->${row.to}`}`));
  const edges = data.edges.filter((edge) => deleted.has(edge.from) || deleted.has(edge.to)).map((edge) => `edge ${edge.from}->${edge.to}`);
  if (citing.length + edges.length > 0) fail(`a deleted capability is still referenced — move or remove these first: ${[...citing, ...edges].slice(0, 8).join(", ")}`);
}

function citesAny(value, { ids, key }) {
  if (key !== undefined && (key === "id" || HISTORY.test(key))) return false;
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((each) => citesAny(each, { ids }));
  if (value && typeof value === "object") return Object.entries(value).some(([name, each]) => citesAny(each, { ids, key: name }));
  return false;
}

/** A restated field keeps what it said before as `legacy_<field>`, the first time only. */
function restate(tree, plan) {
  for (const restated of plan.restatements ?? []) {
    const domain = domainOf(tree, restated.domain);
    for (const [key, value] of Object.entries(restated).filter(([key]) => key !== "domain")) {
      const changed = JSON.stringify(domain[key]) !== JSON.stringify(value);
      if (domain[key] !== undefined && changed && domain[`legacy_${key}`] === undefined) domain[`legacy_${key}`] = domain[key];
      domain[key] = value;
    }
  }
}

/** Every capability and feature numbered in order under its parent: the source's renumber step. */
function capabilityIds(tree) {
  const map = new Map();
  for (const domain of tree) {
    domain.capabilities.forEach((capability, index) => {
      const id = `${domain.id}-${pad(index + 1)}`;
      map.set(capability.id, id);
      capability.features.forEach((feature, at) => map.set(feature.id, `${id}-${pad(at + 1)}`));
    });
  }
  return map;
}

function stamp(record, { from, to, kind }) {
  if (from === to || from.includes("-NEW")) return { ...record, id: to };
  const legacy = `legacy_${kind}_id`;
  return { ...record, id: to, [legacy]: record[legacy] ?? from, id_history: [...(record.id_history ?? record.ext?.id_history ?? []), from] };
}

function flattenCapabilities(tree, map) {
  const domains = tree.map(({ capabilities, ...domain }) => domain);
  const capabilities = tree.flatMap((domain) => domain.capabilities.map(({ features, ...capability }) => ({ ...stamp(capability, { from: capability.id, to: map.get(capability.id), kind: "capability" }), domain_id: domain.id })));
  const features = tree.flatMap((domain) => domain.capabilities.flatMap((capability) => capability.features.map((feature) => ({ ...stamp(feature, { from: feature.id, to: map.get(feature.id), kind: "feature" }), capability_id: map.get(capability.id), domain_id: domain.id }))));
  return { domains, capabilities, features };
}

function counted(data) {
  return { capabilities: data.capabilities.length, features: data.features.length };
}

function remapCapabilities(data, plan) {
  const before = counted(data);
  const tree = capabilityTree(data);
  const moved = new Set();
  addDomains(tree, { plan, moved });
  addCapabilities(tree, plan);
  deleteAndRestate(tree, plan);
  const map = capabilityIds(tree);
  const next = { ...data, ...flattenCapabilities(tree, map) };
  const expected = before.capabilities + (plan.new_capabilities ?? []).length - (plan.deletes ?? []).length;
  if (next.capabilities.length !== expected) fail(`capability count not conserved: ${before.capabilities} → ${next.capabilities.length}, expected ${expected}`);
  if (next.features.length !== before.features) fail(`feature count not conserved: ${before.features} → ${next.features.length}`);
  return { data: next, map };
}

function checkLayout(flow, { layout, have }) {
  const want = layout.stages.flatMap((stage) => stage.processes ?? []);
  if (new Set(want).size !== want.length) fail(`${flow.id}: the layout places a process more than once`);
  const missing = [...have].filter((id) => !want.includes(id));
  const alien = want.filter((id) => !have.has(id));
  if (missing.length > 0 || alien.length > 0) fail(`${flow.id}: the layout must cover the flow's processes exactly; missing ${missing.slice(0, 5)}, alien ${alien.slice(0, 5)}`);
}

/** A stage with no process is a recorded gap, kept with its note — never dropped to tidy the picture. */
function laidStages(flow, { layout, processes }) {
  checkLayout(flow, { layout, have: new Set(processes.map((process) => process.id)) });
  return layout.stages.map((stage) => ({
    record: { entity: "stage", name: stage.name, entry_criteria: stage.entry, exit_criteria: stage.exit, ...(stage.gap || !(stage.processes ?? []).length ? { gap: true, gap_note: stage.note ?? "phase the journey needs; nothing implements it" } : {}) },
    processes: (stage.processes ?? []).map((id) => processes.find((process) => process.id === id)),
  }));
}

function processTree(data, plan) {
  const stages = byParent(data.stages, "flow_id");
  const processes = byParent(data.processes, "stage_id");
  const stageless = data.processes.filter((process) => !data.stages.some((stage) => stage.id === process.stage_id));
  if (stageless.length > 0) fail(`every process needs a stage before the process axis is renumbered; these have none: ${stageless.slice(0, 5).map((process) => process.id).join(", ")}`);
  const layouts = plan.stage_layouts ?? {};
  const unknown = Object.keys(layouts).filter((id) => !data.flows.some((flow) => flow.id === id));
  if (unknown.length > 0) fail(`stage layouts name flows that do not exist: ${unknown.join(", ")}`);
  return data.flows.map((flow) => {
    const own = (stages.get(flow.id) ?? []).map((stage) => ({ record: stage, processes: processes.get(stage.id) ?? [] }));
    return { flow, stages: layouts[flow.id] ? laidStages(flow, { layout: layouts[flow.id], processes: own.flatMap((stage) => stage.processes) }) : own };
  });
}

function processIds(tree, renumber) {
  const map = new Map();
  tree.forEach(({ flow, stages }, index) => {
    const flowId = renumber ? `BF-${pad(index + 1)}` : flow.id;
    map.set(flow.id, flowId);
    stages.forEach((stage, at) => {
      const stageId = `${flowId}.S${at + 1}`;
      if (stage.record.id) map.set(stage.record.id, stageId);
      stage.newId = stageId;
      stage.processes.forEach((process, position) => map.set(process.id, `${stageId}.P${position + 1}`));
    });
  });
  return map;
}

function flattenProcesses(tree, map) {
  const flows = tree.map(({ flow }) => stamp(flow, { from: flow.id, to: map.get(flow.id), kind: "flow" }));
  const stages = tree.flatMap(({ flow, stages: own }) => own.map((stage) => ({ ...(stage.record.id ? stamp(stage.record, { from: stage.record.id, to: stage.newId, kind: "stage" }) : { ...stage.record, id: stage.newId }), flow_id: map.get(flow.id) })));
  const processes = tree.flatMap(({ flow, stages: own }) => own.flatMap((stage) => stage.processes.map((process) => ({ ...stamp(process, { from: process.id, to: map.get(process.id), kind: "process" }), flow_id: map.get(flow.id), stage_id: stage.newId }))));
  return { flows, stages, processes };
}

function remapProcesses(data, plan) {
  if (!plan.stage_layouts && !plan.renumber_flows) return { data, map: new Map() };
  const tree = processTree(data, plan);
  const map = processIds(tree, plan.renumber_flows === true);
  const next = { ...data, ...flattenProcesses(tree, map) };
  if (next.processes.length !== data.processes.length) fail(`process count not conserved: ${data.processes.length} → ${next.processes.length}`);
  return { data: next, map };
}

/** Every exact old id, in any field but a record's own id and its history, becomes its new id. */
function rewrite(value, { map, key, prose }) {
  if (key !== undefined && (key === "id" || HISTORY.test(key))) return value;
  if (typeof value === "string") {
    if (map.has(value)) return map.get(value);
    return prose ? value.replace(CAPABILITY_ID, (id) => map.get(id) ?? id) : value;
  }
  if (Array.isArray(value)) return value.map((each) => rewrite(each, { map, prose }));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, rewrite(each, { map, key: name, prose })]));
  return value;
}

const CAPABILITY_AXIS = new Set(["domains", "capabilities", "features"]);

/**
 * The parent fields the flattening already set to NEW ids. Rewriting them again would carry a
 * new id that happens to be another node's old one a second step — the chain the source warns
 * about (`DOM-DSH-04` → `DOM-DSH-03` while `DOM-DSH-03` → `DOM-PNV-01`).
 */
const ALREADY_NEW = { capabilities: ["domain_id"], features: ["capability_id", "domain_id"], stages: ["flow_id"], processes: ["flow_id", "stage_id"] };

/** Ledger records are what happened: a remap table written into one stays as it was written. */
const LEDGERS = new Set(["updates", "intakes", "releases", "debts"]);
const PROCESS_AXIS = new Set(["flows", "stages", "processes"]);

/** The source's process-map pass records each field it rewrote as `legacy_<field>`, once. */
function legacyFields(before, after) {
  const changed = Object.keys(after).filter((key) => typeof before[key] === "string" && before[key] !== after[key] && !(`legacy_${key}` in before) && !HISTORY.test(key) && key !== "id");
  return Object.fromEntries(changed.map((key) => [`legacy_${key}`, before[key]]));
}

function rewriteRow(row, { name, map }) {
  if (LEDGERS.has(name)) return row;
  const kept = Object.fromEntries((ALREADY_NEW[name] ?? []).filter((key) => key in row).map((key) => [key, row[key]]));
  const rewritten = { ...rewrite(row, { map, prose: CAPABILITY_AXIS.has(name) }), ...kept };
  return PROCESS_AXIS.has(name) ? { ...rewritten, ...legacyFields(row, rewritten) } : rewritten;
}

function rewriteAll(data, map) {
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.map((row) => rewriteRow(row, { name, map }))]));
}

/** A process follows its capability to that capability's new domain, keeping where it was. */
function realignProcesses(data) {
  const domainOfCapability = new Map(data.capabilities.map((capability) => [capability.id, capability.domain_id]));
  const processes = data.processes.map((process) => {
    const domain = domainOfCapability.get(process.primary_capability_id);
    if (process.primary_capability_id && !domain) fail(`process ${process.id} names capability ${process.primary_capability_id}, which does not exist after the remap`);
    if (!domain || domain === process.primary_domain_id) return process;
    return { ...process, primary_domain_id: domain, legacy_primary_domain_id: process.legacy_primary_domain_id ?? process.primary_domain_id };
  });
  return { ...data, processes };
}

/** The whole plan, applied in memory: the new data and the round's old-to-new table. */
export function remapStore(data, plan) {
  checkDeletes(data, plan);
  checkDanglingDeletes(data, plan);
  const capabilities = remapCapabilities(data, plan);
  const processes = remapProcesses(capabilities.data, plan);
  const map = new Map([...capabilities.map, ...processes.map]);
  if (new Set(map.values()).size !== map.size) fail("the new ids are not unique (the old-to-new map is not a bijection)");
  const changed = new Map([...map].filter(([from, to]) => from !== to && !from.includes("-NEW")));
  return { data: realignProcesses(rewriteAll(processes.data, changed)), changed };
}
