import { COLLECTIONS, canonical, edgeKey } from "./contract.mjs";
import { derive, stripDerived } from "./derive.mjs";
import { renderGates, runGates } from "./gates.mjs";
import { idScheme, nextId } from "./ids.mjs";
import { DnaError, buildManifest, readStore, writeStore } from "./store.mjs";

/**
 * The one way into the store. A batch names records to add or change and records to remove;
 * kiln assigns the ids the contract makes mechanical, derives what the store computes, runs
 * every gate, and writes only when all of them pass.
 *
 * Within one batch a record may carry `key`, and any string `@<key>` elsewhere in the batch
 * becomes that record's id — so a draft can add findings and the feature that owns them at
 * once, before either has an id.
 */

const DERIVED_ONLY = new Set(["components"]);

function mergeRecord(existing, patch) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** `lenient` leaves an unknown `@key` alone: ids are counted before every key is known. */
function resolveRefs(value, { keys, lenient = false }) {
  if (typeof value === "string" && value.startsWith("@")) {
    if (keys.has(value.slice(1))) return keys.get(value.slice(1));
    if (lenient) return value;
    throw new DnaError(`the batch refers to ${value}, and no record in it carries key "${value.slice(1)}".`);
  }
  if (Array.isArray(value)) return value.map((each) => resolveRefs(each, { keys, lenient }));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, resolveRefs(each, { keys, lenient })]));
  return value;
}

function assignId(entity, { record, taken }) {
  if (record.id) return record.id;
  const scheme = idScheme(entity, record);
  if (!scheme) throw new DnaError(`a new ${entity} needs an id: its id is chosen by a person (references/id-schemes.md), not counted.`);
  return nextId(taken, scheme);
}

const DATED = new Set(["update", "intake", "release", "debt"]);

/**
 * First pass: every draft gets its id, in collection order, so a parent's id exists before a
 * child counts under it. References are resolved leniently here and strictly in the second.
 */
function assignIds(upsert, batch) {
  const drafts = {};
  for (const name of Object.keys(COLLECTIONS).filter((each) => upsert[each] && each !== "edges")) {
    const entity = COLLECTIONS[name];
    drafts[name] = upsert[name].map((draft) => {
      const { key, ...fields } = resolveRefs(draft, { keys: batch.keys, lenient: true });
      const record = DATED.has(entity) && !fields.date ? { ...fields, date: batch.today } : fields;
      const id = assignId(entity, { record, taken: batch.taken });
      batch.taken.add(id);
      if (key !== undefined) batch.keys.set(String(key), id);
      batch.assigned.push({ entity, key, id });
      return { ...record, id };
    });
  }
  return drafts;
}

function upsertEntity(rows, { entity, draft, batch }) {
  const { key, ...fields } = resolveRefs(draft, { keys: batch.keys });
  const index = rows.findIndex((row) => row.id === fields.id);
  const record = canonical(entity, index === -1 ? fields : mergeRecord(rows[index], fields));
  return index === -1 ? [...rows, record] : rows.map((row, at) => (at === index ? record : row));
}

function upsertEdge(edges, { draft, batch }) {
  const edge = { entity: "edge", ...resolveRefs(draft, { keys: batch.keys }) };
  if (!edge.from || !edge.to || !edge.kind) throw new DnaError(`an edge needs from, to and kind: ${JSON.stringify(draft)}`);
  const identity = edgeKey(edge);
  return [...edges.filter((each) => edgeKey(each) !== identity), edge];
}

function applyUpserts(data, { upsert, batch }) {
  const unknown = Object.keys(upsert).filter((name) => !(name in COLLECTIONS) || DERIVED_ONLY.has(name));
  if (unknown.length > 0) throw new DnaError(`a batch cannot write ${unknown.join(", ")}: components are derived from findings, and anything else is not a collection.`);
  const drafts = { ...assignIds(upsert, batch), edges: upsert.edges ?? [] };
  const next = { ...data };
  for (const name of Object.keys(COLLECTIONS).filter((each) => drafts[each])) {
    for (const draft of drafts[name]) {
      next[name] = name === "edges" ? upsertEdge(next[name], { draft, batch }) : upsertEntity(next[name], { entity: COLLECTIONS[name], draft, batch });
    }
  }
  return next;
}

/** A finding id is never reused (id-schemes.md), so a finding is not removed here. */
function applyRemovals(data, remove) {
  const next = { ...data };
  for (const [name, targets] of Object.entries(remove)) {
    if (!(name in COLLECTIONS) || name === "findings" || DERIVED_ONLY.has(name)) throw new DnaError(`a batch cannot remove ${name}.`);
    const identify = name === "edges" ? edgeKey : (row) => row.id;
    const wanted = new Set(targets.map((target) => (name === "edges" ? edgeKey(target) : target)));
    const missing = [...wanted].filter((target) => !next[name].some((row) => identify(row) === target));
    if (missing.length > 0) throw new DnaError(`${name} has no ${missing.map((each) => each.split("\u0000").join(" ")).join(", ")} to remove.`);
    next[name] = next[name].filter((row) => !wanted.has(identify(row)));
  }
  return next;
}

function mergeSettings(settings, patch) {
  return mergeRecord(settings, patch ?? {});
}

const PROVENANCE = /^(?:previous_|legacy_|merged_from|split_from|id_history)/;

/**
 * Every id in use, and every id a record names as its history: a removed node's id lives on in
 * the `merged_from` of what replaced it, and counting it free again would make an old citation
 * resolve to a different thing.
 */
function takenIds(data) {
  const rows = Object.keys(COLLECTIONS).filter((name) => name !== "edges").flatMap((name) => data[name]);
  const history = rows.flatMap((row) => Object.entries(row).filter(([key]) => PROVENANCE.test(key)).flatMap(([, value]) => [value].flat()));
  return new Set([...rows.map((row) => row.id), ...history.filter((value) => typeof value === "string")]);
}

/**
 * What the store becomes under `batch`, gated, and not yet written. `kiln dna build` is the
 * empty batch: it derives again from the records as they stand.
 */
export function planBatch(root, { batch, today }) {
  const current = readStore(root);
  const settings = mergeSettings(current.settings, batch.settings);
  const stripped = stripDerived(current.data);
  const base = applyRemovals(stripped, batch.remove ?? {});
  const state = { keys: new Map(), taken: takenIds(stripped), assigned: [], today };
  const data = derive(applyUpserts(base, { upsert: batch.upsert ?? {}, batch: state }), settings);
  const gates = runGates({ data, settings });
  return { data, settings, gates, assigned: state.assigned, previous: current.manifest };
}

export function applyBatch(root, { batch, today }) {
  const plan = planBatch(root, { batch, today });
  if (plan.gates.failed.length > 0) {
    throw new DnaError(`${plan.gates.failed.length} gate(s) failed; the store was left as it was.\n${renderGates({ results: plan.gates.failed })}`);
  }
  writeStore(root, { data: plan.data, settings: plan.settings, manifest: buildManifest(root, { data: plan.data, settings: plan.settings, previous: plan.previous }) });
  return plan;
}

/**
 * Every gate over the store as written, plus the one the write path cannot check on itself:
 * that the derived fields on disk are what the records derive to. A store edited by hand, or
 * written by an older kiln, fails here rather than answering from fields nothing recomputed.
 */
export function checkStore(root) {
  const { data, settings, manifest } = readStore(root);
  const gates = runGates({ data, settings, manifest });
  const fresh = derive(stripDerived(data), settings);
  const stale = Object.keys(COLLECTIONS).filter((name) => JSON.stringify(fresh[name]) !== JSON.stringify(data[name]));
  const derivation = { label: "derived fields are what the records derive to", bad: stale, detail: stale.length > 0 ? `${stale.join(", ")} — \`kiln dna build\` derives them again` : "" };
  const results = [...gates.results, derivation];
  return { results, failed: results.filter((result) => result.bad?.length > 0), warnings: gates.warnings, manifest };
}
