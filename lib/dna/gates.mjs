import { COLLECTIONS, METHODOLOGY_VERSION, VOCAB } from "./contract.mjs";
import { ID_SHAPES } from "./ids.mjs";

/**
 * The gates of tps-project-dna's `build_dna_store.py` and `check_gates.py`, as one list. The
 * source ran them twice — once before writing, once on a built store — and the two copies had
 * drifted (the builder checked that every feature names a capability, the checker did not).
 * Here there is one list, run before every write and by `kiln dna check`.
 *
 * Each gate returns `{ label, bad, detail }` — `bad` is what failed, empty when it passed —
 * or `{ label, warn }` for what is reported but never blocks.
 */

const JARGON_TERMS = ["controller", "endpoint", "middleware", "ORM", "recordset", "cron", "database table", "SQL", "CSRF", "CORS", "session token", "bearer token", "API", "HTTP", "JSON", "XML-RPC", "webhook", "callback", "regex", "primary key", "foreign key", "stored procedure", "cache invalidation"];
const JARGON_TERM = new RegExp(`\\b(?:${JARGON_TERMS.map((term) => term.replace(/[-.]/g, "\\$&")).join("|")})\\b`, "gi");
const JARGON_PATTERNS = [/\b[a-z_]{2,}\.[a-z_]{2,}(?:\.[a-z_]{2,})?\b/g, /\b[a-z]+_[a-z]+_[a-z_]+\b/g];
const JARGON_ALLOW = new Set(["e.g", "i.e", "etc", "vs", "no.", "vol."]);

const FEATURE_BD_KEYS = ["what_it_does", "input", "process", "output"];
const CAPABILITY_BD_KEYS = ["what_you_can_do", "who_uses_it", "business_outcome", "boundary"];
const RULE_BUCKETS = ["business_rules", "validation_rules", "state_rules", "defaulting_rules", "integration_rules", "ui_behaviors", "status_transition", "exception_flow"];
const EXAMPLES = 5;

function gate(label, { bad, passed = "" }) {
  return { label, bad, detail: bad.length > 0 ? JSON.stringify(bad.slice(0, EXAMPLES)) : passed };
}

function ids(rows) {
  return new Set(rows.map((row) => row.id));
}

function duplicates(values) {
  const seen = new Set();
  return [...new Set(values.filter((value) => seen.has(value) || !seen.add(value)))];
}

function entityCollections() {
  return Object.keys(COLLECTIONS).filter((name) => name !== "edges");
}

function allIds(data) {
  return new Set(entityCollections().flatMap((name) => data[name].map((row) => row.id)));
}

export function jargonHits(text) {
  const terms = [...text.matchAll(JARGON_TERM)].map((match) => match[0]);
  const shapes = JARGON_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]));
  return [...terms, ...shapes.filter((token) => !JARGON_ALLOW.has(token.toLowerCase()))];
}

function conservation({ data, manifest }) {
  if (!manifest) return [];
  const bad = Object.entries(manifest.counts ?? {}).filter(([name, count]) => name in data && data[name].length !== count).map(([name, count]) => `${name}: manifest ${count}, file ${data[name].length}`);
  return [gate("conservation: manifest counts match recount", { bad })];
}

function identity({ data }) {
  const names = entityCollections();
  const missing = names.filter((name) => data[name].some((row) => !row.id));
  const repeated = names.flatMap((name) => duplicates(data[name].map((row) => row.id)).map((id) => `${name}:${id}`));
  const malformed = names.flatMap((name) => data[name].filter((row) => row.id && ID_SHAPES[COLLECTIONS[name]] && !ID_SHAPES[COLLECTIONS[name]].test(row.id)).map((row) => row.id));
  return [
    gate("ids present", { bad: missing }),
    gate("id uniqueness per file", { bad: repeated }),
    gate("ids follow the id schemes", { bad: malformed }),
  ];
}

function references({ data }) {
  const known = allIds(data);
  const dangling = data.edges.filter((edge) => !known.has(edge.from) || !known.has(edge.to)).map((edge) => `${edge.from}->${edge.to} ${edge.kind}`);
  // The source checks features and processes; a capability and a stage carry their parent
  // too, and kiln's `remove` is the first operation that could leave one pointing at nothing.
  const parents = { capabilities: ["domain_id"], features: ["capability_id", "domain_id"], stages: ["flow_id"], processes: ["flow_id", "stage_id"] };
  const ancestors = Object.entries(parents).flatMap(([name, keys]) => data[name].flatMap((row) => keys.filter((key) => row[key] && !known.has(row[key])).map((key) => `${row.id}.${key}`)));
  const homeless = data.features.filter((row) => !row.capability_id).map((row) => row.id);
  const orphanFindings = data.findings.filter((row) => row.feature_id && !known.has(row.feature_id)).map((row) => row.id);
  return [
    gate("no dangling edge endpoints", { bad: dangling, passed: `${data.edges.length} edges` }),
    gate("denormalized ancestor ids resolve", { bad: ancestors }),
    gate("every feature names its capability", { bad: homeless }),
    gate("findings: feature_id resolves when set", { bad: orphanFindings }),
  ];
}

/**
 * glossary.md: "the finding→Feature relation is exhaustive and exclusive". The source checked it
 * in each round's merge script; here the exclusive half and the resolving half are gates on
 * every write, and the exhaustive half is a warning, because a store mid-bootstrap has findings
 * no clustering pass has reached yet.
 */
function partition({ data }) {
  const owners = [...data.features, ...data.excluded];
  const claimed = owners.flatMap((row) => row.rd_ids ?? []);
  const findings = ids(data.findings);
  const unowned = data.findings.filter((row) => row.status !== "PLANNED" && !claimed.includes(row.id)).length;
  return [
    gate("rd_ids resolve to findings", { bad: [...new Set(claimed.filter((id) => !findings.has(id)))] }),
    gate("a finding belongs to at most one feature or excluded entry", { bad: duplicates(claimed) }),
    ...(owners.length > 0 && unowned > 0 ? [{ label: "findings no feature or excluded entry owns yet", warn: `${unowned}/${data.findings.length}` }] : []),
  ];
}

function descriptionGates(rows, { keys, noun, exempt }) {
  const shaped = rows.filter((row) => row.business_description !== undefined);
  const malformed = shaped.filter((row) => typeof row.business_description !== "object" || Array.isArray(row.business_description)).map((row) => row.id);
  const complete = (row) => keys.every((key) => typeof row.business_description[key] === "string" && row.business_description[key].trim());
  const incomplete = shaped.filter((row) => !malformed.includes(row.id) && !exempt(row) && !complete(row)).map((row) => row.id);
  const jargon = shaped.filter((row) => !malformed.includes(row.id)).flatMap((row) => keys.flatMap((key) => (typeof row.business_description[key] === "string" ? jargonHits(row.business_description[key]).map((hit) => `${row.id}.${key}: ${hit}`) : [])));
  const results = [
    gate(`${noun} business_description shape (object where present)`, { bad: malformed }),
    gate(`${noun} business_description has all 4 keys where present`, { bad: incomplete }),
    gate(`jargon-lint on ${noun} business_description`, { bad: jargon, passed: "0 hits" }),
  ];
  if (rows.length > shaped.length) results.push({ label: `${noun} business_description coverage partial`, warn: `${shaped.length}/${rows.length}` });
  return results;
}

function descriptions({ data }) {
  return [
    ...descriptionGates(data.features, { keys: FEATURE_BD_KEYS, noun: "feature", exempt: (row) => row.status === "PLANNED" }),
    ...descriptionGates(data.capabilities, { keys: CAPABILITY_BD_KEYS, noun: "capability", exempt: () => false }),
  ];
}

function intakeVerdicts(intake) {
  const verdicts = intake.verdicts ?? (intake.ext?.verdict ? [intake.ext.verdict] : []);
  return [...verdicts, ...(intake.ext?.verdicts ?? [])].filter((verdict) => verdict && typeof verdict === "object");
}

function reservedFeatures(intakes) {
  return new Set(intakes.flatMap((intake) => [...intakeVerdicts(intake).map((verdict) => verdict.proposed_id), intake.ext?.proposed_id]).filter(Boolean));
}

function reservedSurfaces(intakes) {
  const entries = intakes.flatMap((intake) => [...(intake.ext?.cross_reference ?? [])]);
  return new Set(entries.filter((entry) => entry.axis === "infra" && entry.status === "NEW" && entry.node_id).map((entry) => entry.node_id));
}

function reservedFindings(intakes) {
  return new Set(intakes.flatMap((intake) => intakeVerdicts(intake).flatMap((verdict) => (verdict.planned_findings ?? []).map((planned) => planned?.proposed_id))).filter(Boolean));
}

const PROVENANCE = /^(?:previous_|legacy_)/;

function provenance({ data }) {
  const names = ["domains", "capabilities", "features", "processes", "flows", "stages"];
  const bad = names.flatMap((name) => data[name].flatMap((row) => Object.entries(row).filter(([key, value]) => PROVENANCE.test(key) && (value === null || value === "" || (Array.isArray(value) && value.length === 0))).map(([key]) => `${row.id}.${key}`)));
  return [gate("provenance fields non-empty where present", { bad })];
}

function plannedFeatures({ data }) {
  const planned = data.features.filter((row) => row.status === "PLANNED");
  const reserved = reservedFeatures(data.intakes);
  return [
    gate("feature status closed vocab (PLANNED or absent)", { bad: data.features.filter((row) => row.status !== undefined && row.status !== "PLANNED").map((row) => row.id) }),
    gate("PLANNED features carry no rd_ids", { bad: planned.filter((row) => row.rd_ids?.length).map((row) => row.id), passed: `${planned.length} PLANNED` }),
    gate("PLANNED features trace to an intake proposed_id", { bad: planned.filter((row) => !reserved.has(row.id)).map((row) => row.id) }),
  ];
}

function plannedSurfaces({ data }) {
  const planned = data.surfaces.filter((row) => row.status === "PLANNED");
  const reserved = reservedSurfaces(data.intakes);
  return [
    gate("surface status closed vocab (PLANNED or absent)", { bad: data.surfaces.filter((row) => row.status !== undefined && row.status !== "PLANNED").map((row) => row.id) }),
    gate("PLANNED surfaces carry no primary_paths", { bad: planned.filter((row) => row.primary_paths?.length).map((row) => row.id), passed: `${planned.length} PLANNED` }),
    gate("PLANNED surfaces trace to an intake cross_reference entry", { bad: planned.filter((row) => !reserved.has(row.id)).map((row) => row.id) }),
  ];
}

function plannedFindings({ data }) {
  const planned = data.findings.filter((row) => row.status === "PLANNED");
  const reserved = reservedFindings(data.intakes);
  const features = ids(data.features);
  return [
    gate("finding status closed vocab (PLANNED or absent)", { bad: data.findings.filter((row) => row.status !== undefined && row.status !== "PLANNED").map((row) => row.id) }),
    gate("PLANNED findings use the PRD-#### namespace, never RD-####", { bad: planned.filter((row) => !row.id.startsWith("PRD-")).map((row) => row.id), passed: `${planned.length} PLANNED` }),
    gate("non-PLANNED findings never use the PRD-#### namespace", { bad: data.findings.filter((row) => row.status !== "PLANNED" && String(row.id).startsWith("PRD-")).map((row) => row.id) }),
    gate("PLANNED findings carry no evidence", { bad: planned.filter((row) => row.evidence?.length).map((row) => row.id) }),
    gate("PLANNED findings: feature_id resolves", { bad: planned.filter((row) => row.feature_id && !features.has(row.feature_id)).map((row) => row.id) }),
    gate("PLANNED findings trace to an intake planned_findings entry", { bad: planned.filter((row) => !reserved.has(row.id)).map((row) => row.id) }),
  ];
}

function debts({ data }) {
  const updates = ids(data.updates);
  const bad = data.debts.filter((row) => !VOCAB.debtKinds.includes(row.kind) || !VOCAB.debtStatuses.includes(row.status) || (row.status === "SETTLED" && !updates.has(row.settled_by))).map((row) => row.id);
  return [gate("debts: kind/status closed vocab; SETTLED cites a real update round", { bad, passed: `${data.debts.length} debts` })];
}

function infra({ data }) {
  const services = ids(data.services);
  const surfaces = ids(data.surfaces);
  const topology = data.edges.filter((edge) => edge.kind === "TOPOLOGY");
  return [
    gate("services: kind closed vocab", { bad: data.services.filter((row) => !VOCAB.serviceKinds.includes(row.kind)).map((row) => row.id), passed: `${services.size} services` }),
    gate("surfaces: kind closed vocab; service_id resolves", { bad: data.surfaces.filter((row) => !VOCAB.surfaceKinds.includes(row.kind) || (row.service_id && !services.has(row.service_id))).map((row) => row.id) }),
    gate("topology edges: closed types, service endpoints only", { bad: topology.filter((edge) => !VOCAB.topologyTypes.includes(edge.type) || !services.has(edge.from) || !services.has(edge.to)).map((edge) => `${edge.from}->${edge.to}`) }),
    gate("findings: service_id resolves when set", { bad: data.findings.filter((row) => row.service_id && !services.has(row.service_id)).map((row) => row.id) }),
    gate("findings: surface_id resolves when set", { bad: data.findings.filter((row) => row.surface_id && !surfaces.has(row.surface_id)).map((row) => row.id) }),
    ...surfaceCoverage(data),
  ];
}

function surfaceCoverage(data) {
  const withPaths = data.surfaces.filter((row) => row.primary_paths?.length).length;
  const linked = data.findings.filter((row) => row.surface_id).length;
  return linked === 0 && withPaths > 0 ? [{ label: "findings: surface_id set-count", warn: `0 findings linked despite ${withPaths} surfaces carrying primary_paths` }] : [];
}

function edgeKinds({ data }) {
  const external = new Set(data.services.filter((row) => row.kind === "EXTERNAL").map((row) => row.id));
  const processes = ids(data.processes);
  const surfaceKind = new Map(data.surfaces.map((row) => [row.id, row.kind]));
  const ofKind = (kind) => data.edges.filter((edge) => edge.kind === kind);
  const derived = (edge) => VOCAB.derivations.includes(edge.derivation);
  const label = (edge) => `${edge.from}->${edge.to}`;
  return [
    gate("EXTERNAL_HOP edges: closed derivation/channel, process->EXTERNAL", { bad: ofKind("EXTERNAL_HOP").filter((edge) => !derived(edge) || !VOCAB.hopChannels.includes(edge.channel) || !processes.has(edge.from) || !external.has(edge.to)).map(label) }),
    gate("SURFACE_CALLS edges: closed derivation, SCREEN->API", { bad: ofKind("SURFACE_CALLS").filter((edge) => !derived(edge) || surfaceKind.get(edge.from) !== "SCREEN" || surfaceKind.get(edge.to) !== "API").map(label) }),
    gate("PROCESS_SURFACE edges: closed derivation, real endpoints, file-tier only", { bad: badProcessSurfaces(data, { processes, surfaceKind }).map(label) }),
  ];
}

/** A module-prefix match is a module-level claim, which the source's vocabulary forbids as an edge. */
function badProcessSurfaces(data, { processes, surfaceKind }) {
  const moduleOf = new Map(data.findings.map((row) => [row.id, String(row.module ?? "").replace(/\\/g, "/")]));
  const pathsOf = new Map(data.surfaces.map((row) => [row.id, new Set((row.primary_paths ?? []).map((path) => path.replace(/\\/g, "/")))]));
  return data.edges.filter((edge) => edge.kind === "PROCESS_SURFACE").filter((edge) => {
    const shaped = VOCAB.derivations.includes(edge.derivation) && processes.has(edge.from) && surfaceKind.has(edge.to) && edge.support >= 1;
    const module = moduleOf.get(edge.evidence);
    return !shaped || module === undefined || !pathsOf.get(edge.to)?.has(module);
  });
}

function actors({ data, settings }) {
  const registry = settings.actors;
  if (!Array.isArray(registry)) return [];
  const owner = new Map();
  const clashes = registry.flatMap((actor) => [actor.name, ...(actor.aliases ?? [])].filter(Boolean).filter((alias) => {
    const key = alias.toLowerCase();
    const clash = owner.has(key) && owner.get(key) !== actor.name;
    if (!owner.has(key)) owner.set(key, actor.name);
    return clash;
  }));
  const names = new Set(registry.map((actor) => actor.name));
  return [
    gate("actor registry: kind closed vocab (HUMAN|SYSTEM|EXTERNAL)", { bad: registry.filter((actor) => !VOCAB.actorKinds.includes(actor.kind)).map((actor) => actor.name), passed: `${registry.length} entries` }),
    gate("actor registry: no near-duplicate names/aliases across entries", { bad: [...duplicates(registry.map((actor) => String(actor.name).toLowerCase())), ...clashes] }),
    gate("processes: every actors value resolves to a registry name", { bad: data.processes.flatMap((row) => (row.actors ?? []).filter((name) => !names.has(name)).map((name) => `${row.id}: ${name}`)) }),
  ];
}

function ruleBuckets({ data }) {
  const bad = data.processes.flatMap((row) => RULE_BUCKETS.filter((bucket) => row[bucket] !== undefined && !Array.isArray(row[bucket])).map((bucket) => `${row.id}.${bucket}`));
  return [gate("processes: every rule-bucket field is a list", { bad })];
}

function components({ data, settings }) {
  if (data.components.length === 0) return [];
  const services = ids(data.services);
  const cited = new Set(data.findings.map((row) => row.component_id));
  const own = { features: ids(data.features), excluded: ids(data.excluded), surfaces: ids(data.surfaces) };
  const crossRefs = data.components.flatMap((row) => [...(row.feature_ids ?? []).filter((id) => !own.features.has(id)), ...(row.excluded_ids ?? []).filter((id) => !own.excluded.has(id)), ...(row.surface_ids ?? []).filter((id) => !own.surfaces.has(id))]);
  const unmatched = (settings.components?.custom ?? []).filter((name) => !data.components.some((row) => row.name === name));
  return [
    gate("components: id format, kind/origin closed vocab, service_id resolves", { bad: data.components.filter((row) => !ID_SHAPES.component.test(row.id) || !VOCAB.componentKinds.includes(row.kind) || !VOCAB.componentOrigins.includes(row.origin) || (row.service_id && !services.has(row.service_id))).map((row) => row.id), passed: `${data.components.length} components` }),
    gate("components: feature_ids/excluded_ids/surface_ids resolve to their own collections", { bad: [...new Set(crossRefs)] }),
    gate("findings: component_id set on every finding carrying a module", { bad: data.findings.filter((row) => row.module && !row.component_id).map((row) => row.id) }),
    gate("findings: component_id resolves", { bad: data.findings.filter((row) => row.component_id && !ids(data.components).has(row.component_id)).map((row) => row.id) }),
    gate("components: every component is cited by at least one finding", { bad: data.components.filter((row) => !cited.has(row.id)).map((row) => row.id) }),
    gate("components: one service per component", { bad: splitComponents(data.findings) }),
    ...(unmatched.length > 0 ? [{ label: "components: declared custom module root matches no component", warn: JSON.stringify(unmatched.slice(0, EXAMPLES)) }] : []),
  ];
}

function splitComponents(findings) {
  const services = new Map();
  for (const row of findings.filter((each) => each.component_id && each.service_id)) services.set(row.component_id, new Set([...(services.get(row.component_id) ?? []), row.service_id]));
  return [...services].filter(([, owners]) => owners.size > 1).map(([id]) => id).sort();
}

function reachability({ data }) {
  const topology = data.edges.filter((edge) => edge.kind === "TOPOLOGY");
  const lifted = topology.filter((edge) => edge.derivation);
  const inbound = new Set(topology.map((edge) => edge.to));
  const external = data.services.filter((row) => row.kind === "EXTERNAL");
  const hasTopology = data.edges.some((edge) => edge.kind === "TOPOLOGY" || edge.kind === "EXTERNAL_HOP");
  const unevidenced = topology.filter((edge) => !edge.derivation && !edge.evidence && !edge.rd_ids?.length).map((edge) => `${edge.from}->${edge.to}`);
  return [
    gate("TOPOLOGY hop-lift edges: derivation closed, CALLS, support>=1", { bad: lifted.filter((edge) => edge.derivation !== "hop-lift" || edge.type !== "CALLS" || !Number.isInteger(edge.support) || edge.support < 1).map((edge) => `${edge.from}->${edge.to}`) }),
    ...(unevidenced.length > 0 ? [{ label: "TOPOLOGY authored edges without evidence/rd_ids", warn: JSON.stringify(unevidenced.slice(0, EXAMPLES)) }] : []),
    ...(hasTopology ? [gate("services: every EXTERNAL service has an inbound TOPOLOGY edge", { bad: external.filter((row) => !inbound.has(row.id)).map((row) => row.id), passed: `${external.length} EXTERNAL services reachable` })] : []),
    gate("services: code-bearing services declare root_paths or module_keywords", { bad: data.services.filter((row) => ["FRONTEND", "BACKEND", "GATEWAY"].includes(row.kind) && !row.root_paths?.length && !row.module_keywords?.length).map((row) => row.id) }),
  ];
}

function stamp({ manifest }) {
  const version = manifest?.dna_methodology_version;
  if (!version || version === METHODOLOGY_VERSION) return [];
  return [{ label: "methodology version stamp differs from this kiln", warn: `store stamped ${version}, kiln implements ${METHODOLOGY_VERSION}` }];
}

const GATES = [conservation, identity, references, partition, descriptions, provenance, plannedFeatures, plannedSurfaces, plannedFindings, debts, infra, edgeKinds, actors, ruleBuckets, components, reachability, stamp];

/** Every gate over one store: `{ data, settings, manifest? }`. */
export function runGates(store) {
  const results = GATES.flatMap((check) => check(store));
  return { results, failed: results.filter((result) => result.bad?.length > 0), warnings: results.filter((result) => result.warn) };
}

export function renderGates({ results }) {
  return results.map((result) => {
    if (result.warn) return `[WARN] ${result.label} — ${result.warn}`;
    const mark = result.bad.length > 0 ? "FAIL" : "PASS";
    return `[${mark}] ${result.label}${result.detail ? ` — ${result.detail}` : ""}`;
  }).join("\n");
}
