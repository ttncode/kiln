/**
 * The DNA store contract, taken from tps-project-dna v2.18.1 (`build_dna_store.py`,
 * `check_gates.py`, `references/dna-store.md`) under the grant D107 records. The field lists
 * and vocabularies are the contract; changing one here changes what every store means.
 */

export const SCHEMA_VERSION = "1.0";

/** The methodology the definitions in kiln-dna's references were taken from, and its commit. */
export const METHODOLOGY_VERSION = "2.18.1";
export const METHODOLOGY_COMMIT = "4a05eec3139038f72cf5913a8e38065826c7dfed";

/** File order is write order, and `manifest.counts` follows it. */
export const COLLECTIONS = Object.freeze({
  domains: "domain",
  capabilities: "capability",
  features: "feature",
  excluded: "excluded",
  findings: "finding",
  flows: "flow",
  stages: "stage",
  processes: "process",
  updates: "update",
  intakes: "intake",
  releases: "release",
  debts: "debt",
  services: "service",
  surfaces: "surface",
  components: "component",
  edges: "edge",
});

export const CORE_FIELDS = Object.freeze({
  domain: ["name", "type", "purpose"],
  capability: ["domain_id", "name", "scope", "gap_status", "business_description"],
  feature: ["capability_id", "domain_id", "name", "description", "business_description", "size", "size_justification", "business_relevance", "delivery_nature", "abstraction_level", "classification_confidence", "status", "intake_id", "rd_ids", "evidence"],
  excluded: ["catalog", "capability_id", "name", "description", "disposition", "business_relevance", "delivery_nature", "rd_ids", "evidence"],
  finding: ["category", "proposition", "module", "feature_id", "service_id", "confidence", "evidence", "status", "intake_id", "surface_id", "component_id"],
  flow: ["name", "flow_type", "purpose", "trigger", "outcome", "bpm_id", "bpm_mnemonic", "bpm_review"],
  stage: ["flow_id", "name", "objective", "entry_criteria", "exit_criteria", "gap", "gap_note", "bpm_id", "bpm_review"],
  process: ["flow_id", "stage_id", "name", "purpose", "process_kind", "primary_capability_id", "primary_domain_id", "controls_process_id", "jtbd", "decision_maker", "decision_branches", "trigger", "actors", "input", "output", "input_state", "output_state", "process_owner", "channel", "kpi_sla", "evidence", "open_issues", "business_rules", "validation_rules", "state_rules", "defaulting_rules", "integration_rules", "ui_behaviors", "technical_notes", "status_transition", "exception_flow", "system_of_record", "business_object", "bpm_id", "bpm_review"],
  update: ["date", "kind", "title"],
  intake: ["date", "ticket", "title", "verdicts"],
  release: ["date", "status", "title", "features", "services"],
  debt: ["date", "kind", "status", "cites", "owed", "settled_by", "source"],
  service: ["name", "kind", "tech_stack", "repo", "root_paths", "module_keywords"],
  surface: ["service_id", "name", "kind", "res_model", "view_ids", "menu_path", "primary_paths", "status", "intake_id"],
  component: ["service_id", "name", "kind", "origin", "module", "finding_count", "surface_ids", "feature_ids", "excluded_ids"],
});

const PROVENANCE = /^(?:previous_|legacy_|merged_from|split_from)/;

export const VOCAB = Object.freeze({
  serviceKinds: ["FRONTEND", "BACKEND", "DATABASE", "SEARCH", "QUEUE", "CACHE", "GATEWAY", "EXTERNAL"],
  surfaceKinds: ["SCREEN", "API", "BATCH", "ENTITY"],
  componentKinds: ["ADDON", "FRAMEWORK", "PROJECT"],
  componentOrigins: ["CUSTOM", "VENDOR"],
  topologyTypes: ["CALLS", "READS", "WRITES", "PUBLISHES", "SUBSCRIBES"],
  debtKinds: ["HOTFIX", "MAP_OUTDATED", "UNRULED_AREA"],
  debtStatuses: ["OPEN", "SETTLED"],
  actorKinds: ["HUMAN", "SYSTEM", "EXTERNAL"],
  derivations: ["function-match", "file-overlap"],
  hopChannels: ["http", "mail", "sdk"],
});

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

/**
 * A canonical record: `entity` and `id` first, the core fields in contract order, provenance
 * kept on the line, anything else under `ext`. An `ext` the source already carries is kept as
 * `ext` rather than nested inside a new one, because the store is read back and written again.
 */
export function canonical(entity, source) {
  const core = CORE_FIELDS[entity];
  const record = { entity, id: source.id };
  const ext = { ...(source.ext ?? {}) };
  for (const key of core) if (!isEmpty(source[key])) record[key] = source[key];
  for (const [key, value] of Object.entries(source)) {
    if (["entity", "id", "ext"].includes(key) || core.includes(key) || isEmpty(value)) continue;
    if (PROVENANCE.test(key)) record[key] = value;
    else ext[key] = value;
  }
  if (!isEmpty(ext)) record.ext = ext;
  return record;
}

/** An edge has no id; this is what makes two edges the same edge. */
export function edgeKey(edge) {
  return [edge.from, edge.to, edge.kind, edge.type ?? ""].join("\u0000");
}
