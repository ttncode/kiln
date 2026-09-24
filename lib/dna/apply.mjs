import { COLLECTIONS, canonical, edgeKey } from "./contract.mjs";
import { derive, stripDerived } from "./derive.mjs";
import { checkpoint } from "./checkpoint.mjs";
import { checkEvidence } from "./evidence.mjs";
import { renderGates, runGates } from "./gates.mjs";
import { idScheme, nextId } from "./ids.mjs";
import { remapStore } from "./remap.mjs";
import { refuseSecrets } from "./secrets.mjs";
import { repositories, treeAt } from "./scan.mjs";
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

/** `null` removes a field, whether the record keeps it on the line or under `ext`. */
function mergeRecord(existing, patch) {
  const merged = { ...existing, ext: { ...(existing.ext ?? {}) } };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      delete merged.ext[key];
    } else merged[key] = value;
  }
  return merged;
}

const REFERENCE = /^@[\w.:-]+$/;

/**
 * Only a whole `@word` is a reference, so a name that happens to open with `@` stays a name.
 * `lenient` leaves an unknown one alone: ids are counted before every key is known.
 */
function resolveRefs(value, { keys, lenient = false }) {
  if (typeof value === "string" && REFERENCE.test(value)) {
    if (keys.has(value.slice(1))) return keys.get(value.slice(1));
    if (lenient) return value;
    throw new DnaError(`the batch refers to ${value}, and no record in it carries key "${value.slice(1)}".`);
  }
  if (Array.isArray(value)) return value.map((each) => resolveRefs(each, { keys, lenient }));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, resolveRefs(each, { keys, lenient })]));
  return value;
}

function assignId(entity, { record, taken }) {
  if (record.id) {
    if (!taken.live.has(record.id) && taken.history.has(record.id)) throw new DnaError(`${record.id} is another record's history (merged_from, legacy_*, id_history); a new ${entity} cannot take it.`);
    return record.id;
  }
  const scheme = idScheme(entity, record);
  if (!scheme) throw new DnaError(`a new ${entity} needs an id: its id is chosen by a person (references/id-schemes.md), not counted.`);
  return nextId([...taken.live, ...taken.history], scheme);
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
      const record = DATED.has(entity) && !fields.id && !fields.date ? { ...fields, date: batch.today } : fields;
      const id = assignId(entity, { record, taken: batch.taken });
      batch.taken.live.add(id);
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
 * resolve to a different thing. `id_history` is read under `ext` too, where the contract puts it.
 */
function takenIds(data) {
  const rows = Object.keys(COLLECTIONS).filter((name) => name !== "edges").flatMap((name) => data[name]);
  const named = (fields) => Object.entries(fields ?? {}).filter(([key]) => PROVENANCE.test(key)).flatMap(([, value]) => [value].flat());
  const history = rows.flatMap((row) => [...named(row), ...named(row.ext)]).filter((value) => typeof value === "string");
  return { live: new Set(rows.map((row) => row.id)), history: new Set(history) };
}

/** `read` is the scan skeleton's note of where to read each file; it is never written. */
const BATCH_KEYS = new Set(["settings", "upsert", "remove", "scan", "read"]);

const DERIVED_FIELDS = ["service_id", "surface_id", "component_id"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEntry(section, name) {
  if (section === "upsert" || name === "edges") return isObject;
  return (value) => typeof value === "string";
}

function checkSection(batch, section) {
  if (batch[section] === undefined) return;
  if (!isObject(batch[section])) throw new DnaError(`${section} maps each collection to a list.`);
  for (const [name, list] of Object.entries(batch[section])) {
    const entry = isEntry(section, name);
    if (!Array.isArray(list) || !list.every(entry)) throw new DnaError(`${section}.${name} must be a list of ${entry === isObject ? "records" : "ids"}.`);
  }
}

/** Shapes first, so a malformed batch is refused in words rather than failing somewhere inside. */
function checkShape(batch) {
  if (!isObject(batch)) throw new DnaError("a batch is a JSON object.");
  const unknown = Object.keys(batch).filter((key) => !BATCH_KEYS.has(key));
  if (unknown.length > 0) throw new DnaError(`a batch holds settings, upsert, remove and scan; it has ${unknown.join(", ")}.`);
  checkSection(batch, "upsert");
  checkSection(batch, "remove");
}

/**
 * A derived field in a batch would be written, then contradicted by the next rebuild — the
 * store would hold what no derivation gives. It is refused rather than dropped, so the author
 * learns the field is computed.
 */
function refuseDerived(upsert) {
  const finding = (upsert.findings ?? []).find((draft) => DERIVED_FIELDS.some((key) => key in draft) || ("feature_id" in draft && draft.status !== "PLANNED"));
  if (finding) throw new DnaError(`service_id, surface_id, component_id and a non-planned finding's feature_id are derived; a batch cannot set them (${finding.id ?? finding.key ?? "a new finding"}). A finding's feature comes from that feature's rd_ids.`);
  const edge = (upsert.edges ?? []).find((draft) => draft.derivation === "hop-lift" || "hop_support" in draft);
  if (edge) throw new DnaError(`hop-lift edges and hop_support are derived from EXTERNAL_HOP edges; a batch cannot set them (${edge.from}->${edge.to}).`);
}

function repoOwning(repos, path) {
  return [...repos].sort((a, b) => b.path.length - a.path.length).find((repo) => repo.path === "" || path.startsWith(`${repo.path}/`));
}

function checkScanShape(scan) {
  const commits = isObject(scan.commits) && Object.values(scan.commits).every((commit) => typeof commit === "string");
  const files = Array.isArray(scan.files) && scan.files.every((path) => typeof path === "string");
  if (!commits || !files) throw new DnaError("scan holds commits (repository name to commit) and files (a list of paths).");
}

function readAt(repo) {
  const tree = treeAt(repo);
  if (tree.size === 0) throw new DnaError(`${repo.name} has no commit ${repo.commit}.`);
  return tree;
}

/**
 * A scan round's files enter the ledger at the blob their commit holds, and a path that commit
 * no longer has leaves it. The pin moves only when that commit is still the integration
 * branch's tip (D80): a round read at any other commit is recorded, but it does not get to say
 * what the whole store describes.
 */
function recordScan(root, { scan, config, scanned }) {
  if (!scan) return { scanned, pins: {} };
  if (!config) throw new DnaError("a scan round needs the project's config to find its repositories.");
  checkScanShape(scan);
  const current = repositories(root, config);
  const ledger = { ...scanned };
  for (const repo of current.filter((each) => scan.commits[each.name])) {
    const tree = readAt({ ...repo, commit: scan.commits[repo.name] });
    for (const path of Object.keys(ledger).filter((each) => repoOwning(current, each) === repo && !tree.has(each))) delete ledger[path];
    for (const path of scan.files.filter((each) => repoOwning(current, each) === repo)) {
      if (!tree.has(path)) throw new DnaError(`${repo.name} at ${scan.commits[repo.name].slice(0, 12)} has no file ${path}; a scan round can only record files its commit holds.`);
      ledger[path] = tree.get(path);
    }
  }
  const orphan = scan.files.find((path) => !scan.commits[repoOwning(current, path)?.name]);
  if (orphan) throw new DnaError(`the scan names ${orphan} but no commit for its repository under scan.commits.`);
  const pins = Object.fromEntries(current.filter((repo) => repo.pinnable && scan.commits[repo.name] === repo.commit).map((repo) => [repo.name, repo.commit]));
  return { scanned: ledger, pins };
}

/**
 * What the store becomes under `batch`, gated, and not yet written. `kiln dna build` is the
 * empty batch: it derives again from the records as they stand.
 */
export function planBatch(root, { batch, today, config }) {
  checkShape(batch);
  refuseDerived(batch.upsert ?? {});
  refuseSecrets(batch);
  const current = readStore(root);
  const settings = mergeSettings(current.settings, batch.settings);
  checkEvidence(root, { batch, settings, config });
  const stripped = stripDerived(current.data);
  const base = applyRemovals(stripped, batch.remove ?? {});
  const state = { keys: new Map(), taken: takenIds(stripped), assigned: [], today };
  const data = derive(applyUpserts(base, { upsert: batch.upsert ?? {}, batch: state }), settings);
  const gates = runGates({ data, settings });
  const { scanned, pins } = recordScan(root, { scan: batch.scan, config, scanned: current.scanned });
  return { data, settings, gates, scanned, pins, assigned: state.assigned, previous: current.manifest };
}

export function applyBatch(root, { batch, today, config }) {
  const plan = planBatch(root, { batch, today, config });
  if (plan.gates.failed.length > 0) {
    throw new DnaError(`${plan.gates.failed.length} gate(s) failed; the store was left as it was.\n${renderGates({ results: plan.gates.failed })}`);
  }
  const manifest = buildManifest(root, { data: plan.data, settings: plan.settings, previous: plan.previous, pins: plan.pins });
  writeStore(root, { data: plan.data, settings: plan.settings, scanned: plan.scanned, manifest });
  return { ...plan, checkpoint: checkpoint(root) };
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

function recanonical(data) {
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, name === "edges" ? rows : rows.map((row) => canonical(COLLECTIONS[name], row))]));
}

/**
 * A restructuring plan (`kiln dna remap`, D164), gated like any write: the whole store is
 * remapped in memory, derived again, and checked; `apply` false stops there, so the table of
 * id changes can be read before anything moves.
 */
export function remapPlan(root, { plan, apply }) {
  const current = readStore(root);
  const { data: remapped, changed } = remapStore(stripDerived(current.data), plan);
  const data = derive(recanonical(remapped), current.settings);
  const gates = runGates({ data, settings: current.settings });
  if (gates.failed.length > 0) throw new DnaError(`${gates.failed.length} gate(s) failed after the remap; nothing was written.\n${renderGates({ results: gates.failed })}`);
  if (!apply) return { changed, written: false };
  writeStore(root, { data, settings: current.settings, scanned: current.scanned, manifest: buildManifest(root, { data, settings: current.settings, previous: current.manifest }) });
  return { changed, written: true, checkpoint: checkpoint(root) };
}
