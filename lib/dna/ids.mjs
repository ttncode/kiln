/**
 * The id schemes of tps-project-dna `references/id-schemes.md`: ids nest under their parent,
 * count rather than hash, and are never reused. A number is taken from the highest one ever
 * seen, so a gap stays a gap.
 */

const WIDTH = Object.freeze({ finding: 4, dated: 2, capability: 2, feature: 2, flow: 2, stage: 1, process: 1 });

const DATED_PREFIX = Object.freeze({ update: "UPD", intake: "INTAKE", release: "REL", debt: "DEBT" });

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The next id after every `<prefix><digits>` in `taken`, zero-padded to `width`. */
export function nextId(taken, { prefix, width }) {
  const shape = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);
  const highest = [...taken].reduce((max, id) => Math.max(max, Number(shape.exec(id)?.[1] ?? 0)), 0);
  return `${prefix}${String(highest + 1).padStart(width, "0")}`;
}

/**
 * Where a new record's id comes from, or null when the contract gives it no mechanical id:
 * a domain's abbreviation and a service's mnemonic are chosen by a person (id-schemes.md,
 * "Propose the table, get user sign-off").
 */
export function idScheme(entity, record) {
  if (entity === "finding") return { prefix: record.status === "PLANNED" ? "PRD-" : "RD-", width: WIDTH.finding };
  if (entity in DATED_PREFIX) return { prefix: `${DATED_PREFIX[entity]}-${record.date}-`, width: WIDTH.dated };
  return childScheme(entity, record);
}

function childScheme(entity, record) {
  const parent = { capability: record.domain_id, feature: record.capability_id, stage: record.flow_id, process: record.stage_id }[entity];
  const joint = { capability: "-", feature: "-", stage: ".S", process: ".P" }[entity];
  if (entity === "flow") return { prefix: "BF-", width: WIDTH.flow };
  return parent && joint ? { prefix: `${parent}${joint}`, width: WIDTH[entity] } : null;
}

/** Shapes the gates hold ids to, where the contract fixes one. */
export const ID_SHAPES = Object.freeze({
  finding: /^(?:RD|PRD)-\d{4,}$/,
  domain: /^DOM-[A-Z]{2,4}$/,
  capability: /^DOM-[A-Z]{2,4}-\d{2}$/,
  feature: /^DOM-[A-Z]{2,4}-\d{2}-\d{2}$/,
  flow: /^BF-\d{2}$/,
  stage: /^BF-\d{2}\.S\d+$/,
  process: /^BF-\d{2}\.S\d+\.P\d+$/,
  update: /^UPD-\d{4}-\d{2}-\d{2}-\d{2}$/,
  intake: /^INTAKE-\d{4}-\d{2}-\d{2}-\d{2}$/,
  release: /^REL-\d{4}-\d{2}-\d{2}-\d{2}$/,
  debt: /^DEBT-\d{4}-\d{2}-\d{2}-\d{2}$/,
  service: /^SVC-[A-Z0-9-]+$/,
  surface: /^SRF-[A-Z0-9-]+$/,
  component: /^CMP-[A-Z0-9-]+$/,
});
