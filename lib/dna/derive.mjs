import { canonical } from "./contract.mjs";

/**
 * The fields the store computes rather than records, ported from `build_dna_store.py`. They are
 * stripped before every write and derived again, so a store built one batch at a time is the
 * store a clean rebuild of the same records would give — the property an incremental index has
 * to hold or its answers depend on the order it was fed.
 */

const DERIVED_FINDING_FIELDS = ["service_id", "surface_id", "component_id"];

function slash(path) {
  return String(path ?? "").replace(/\\/g, "/");
}

export function stripDerived(data) {
  const findings = data.findings.map((finding) => {
    const kept = Object.fromEntries(Object.entries(finding).filter(([key]) => !DERIVED_FINDING_FIELDS.includes(key)));
    if (finding.status !== "PLANNED") delete kept.feature_id;
    return kept;
  });
  const edges = data.edges.filter((edge) => edge.derivation !== "hop-lift").map(({ hop_support, ...edge }) => edge);
  return { ...data, findings, edges, components: [] };
}

/**
 * Which service owns a path: the longest `root_paths` entry that is the path or a directory
 * above it. Segment-aware, because a bare prefix let `addons/web` claim `addons/website_sale`.
 */
export function serviceOfPath(path, { services, exclude }) {
  const target = slash(path);
  let best = { id: null, length: -1 };
  for (const service of services) {
    if (service.id === exclude) continue;
    for (const raw of service.root_paths ?? []) {
      const root = slash(raw).replace(/\/+$/, "");
      const owns = root && (target === root || target.startsWith(`${root}/`));
      if (owns && root.length > best.length) best = { id: service.id, length: root.length };
    }
  }
  return best.id;
}

/** A keyword claims a module only when exactly one service's keyword does: a blank beats a guess. */
function serviceByKeyword(module, services) {
  const owners = new Set(services.flatMap((service) => (service.module_keywords ?? []).filter((word) => module.includes(word)).map(() => service.id)));
  return owners.size === 1 ? [...owners][0] : null;
}

function withFeatureIds(data) {
  const owner = new Map();
  for (const excluded of data.excluded) for (const id of excluded.rd_ids ?? []) owner.set(id, excluded.id);
  for (const feature of data.features) for (const id of feature.rd_ids ?? []) owner.set(id, feature.id);
  return data.findings.map((finding) => (owner.has(finding.id) ? { ...finding, feature_id: owner.get(finding.id) } : finding));
}

function withServiceIds(findings, services) {
  if (services.length === 0) return findings;
  return findings.map((finding) => {
    const module = slash(finding.module);
    if (!module) return finding;
    const id = serviceOfPath(module, { services }) ?? serviceByKeyword(module, services);
    return id ? { ...finding, service_id: id } : finding;
  });
}

function surfacePrefixes(surfaces) {
  const owners = new Map();
  for (const surface of surfaces) {
    const paths = [...(surface.primary_paths ?? []), ...(surface.ext?.match?.module_prefixes ?? [])];
    for (const path of paths.map(slash)) owners.set(path, new Set([...(owners.get(path) ?? []), surface.id]));
  }
  return { owners, longestFirst: [...owners.keys()].sort((a, b) => b.length - a.length) };
}

/** A prefix two surfaces both claim sets nothing, the same ambiguity rule as the service's. */
function withSurfaceIds(findings, surfaces) {
  if (surfaces.length === 0) return findings;
  const { owners, longestFirst } = surfacePrefixes(surfaces);
  return findings.map((finding) => {
    const module = slash(finding.module);
    const winner = module && longestFirst.find((prefix) => module.startsWith(prefix));
    const claimants = winner ? owners.get(winner) : null;
    return claimants?.size === 1 ? { ...finding, surface_id: [...claimants][0] } : finding;
  });
}

/** The literal root of a module path: an addon, an Odoo framework subtree, or two segments. */
export function componentRoot(module) {
  const parts = slash(module).replace(/^\/+|\/+$/g, "").split("/");
  const addons = parts.indexOf("addons");
  if (addons !== -1 && addons + 1 < parts.length) return { root: parts[addons + 1], kind: "ADDON", prefix: parts.slice(0, addons + 2).join("/") };
  if (parts.length >= 3 && parts[1] === "odoo") return { root: `odoo/${parts[2]}`, kind: "FRAMEWORK", prefix: parts.slice(0, 3).join("/") };
  const two = parts.slice(0, 2).join("/");
  return { root: two, kind: "PROJECT", prefix: two };
}

export function componentId(root) {
  return `CMP-${root.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function rollComponents(findings, featureIds) {
  const roll = new Map();
  for (const finding of findings.filter((each) => each.module)) {
    const { root, kind, prefix } = componentRoot(finding.module);
    const key = `${root}\u0000${kind}`;
    const bucket = roll.get(key) ?? { root, kind, prefix, count: 0, services: new Map(), surfaces: new Set(), features: new Set(), excluded: new Set() };
    bucket.count += 1;
    if (finding.service_id) bucket.services.set(finding.service_id, (bucket.services.get(finding.service_id) ?? 0) + 1);
    if (finding.surface_id) bucket.surfaces.add(finding.surface_id);
    if (finding.feature_id) (featureIds.has(finding.feature_id) ? bucket.features : bucket.excluded).add(finding.feature_id);
    roll.set(key, bucket);
  }
  return [...roll.values()].sort((a, b) => compareCodePoints(a.root, b.root) || compareCodePoints(a.kind, b.kind));
}

/** The source sorts with Python's ordering, which is by code point; `localeCompare` is not. */
function compareCodePoints(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function mostCited(services) {
  return [...services.entries()].reduce((best, entry) => (best && best[1] >= entry[1] ? best : entry), null)?.[0];
}

function componentRecord(bucket, custom) {
  return canonical("component", {
    id: componentId(bucket.root),
    name: bucket.root,
    kind: bucket.kind,
    origin: custom.has(bucket.root) ? "CUSTOM" : "VENDOR",
    module: bucket.prefix,
    service_id: mostCited(bucket.services),
    finding_count: bucket.count,
    surface_ids: [...bucket.surfaces].sort(),
    feature_ids: [...bucket.features].sort(),
    excluded_ids: [...bucket.excluded].sort(),
  });
}

function withComponents(data, settings) {
  const featureIds = new Set(data.features.map((feature) => feature.id));
  const buckets = rollComponents(data.findings, featureIds);
  const custom = new Set(settings.components?.custom ?? []);
  const findings = data.findings.map((finding) => (finding.module ? { ...finding, component_id: componentId(componentRoot(finding.module).root) } : finding));
  return { findings, components: buckets.map((bucket) => componentRecord(bucket, custom)) };
}

function liftedHops(data) {
  const lifted = new Map();
  for (const hop of data.edges.filter((edge) => edge.kind === "EXTERNAL_HOP")) {
    const caller = serviceOfPath(String(hop.evidence ?? "").split(":")[0], { services: data.services, exclude: hop.to });
    if (!caller || caller === hop.to) continue;
    const key = `${caller}\u0000${hop.to}`;
    const entry = lifted.get(key) ?? { from: caller, to: hop.to, count: 0, channels: new Set(), evidence: hop.evidence };
    entry.count += 1;
    if (hop.channel) entry.channels.add(hop.channel);
    lifted.set(key, entry);
  }
  return [...lifted.values()].sort((a, b) => compareCodePoints(a.from, b.from) || compareCodePoints(a.to, b.to));
}

/**
 * An EXTERNAL_HOP is a call site, so it lifts to a service-to-service CALLS edge. An authored
 * edge on the same pair keeps its own line and gains `hop_support` rather than a duplicate.
 */
function withTopology(data) {
  if (data.services.length === 0) return data.edges;
  const edges = data.edges.map((edge) => ({ ...edge }));
  for (const hop of liftedHops(data)) {
    const authored = edges.find((edge) => edge.kind === "TOPOLOGY" && edge.from === hop.from && edge.to === hop.to && edge.type === "CALLS");
    if (authored) authored.hop_support = hop.count;
    else edges.push({ entity: "edge", from: hop.from, to: hop.to, kind: "TOPOLOGY", type: "CALLS", derivation: "hop-lift", support: hop.count, channels: [...hop.channels].sort(), ...(hop.evidence ? { evidence: hop.evidence } : {}) });
  }
  return edges;
}

/** The order is the source's: each step reads what the one before it wrote. */
export function derive(data, settings) {
  const withOwners = { ...data, findings: withSurfaceIds(withServiceIds(withFeatureIds(data), data.services), data.surfaces) };
  const edges = withTopology(withOwners);
  const { findings, components } = withComponents(withOwners, settings);
  return { ...withOwners, findings: findings.map((finding) => canonical("finding", finding)), components, edges };
}
