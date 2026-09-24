/**
 * Phase 5a panel reconciliation, ported from tps-project-dna's `reconcile_5a.py` (D166). Several
 * panels each propose the journey set — every process placed in one flow — and this computes
 * where they agree and isolates where they do not, so the adjudication a person or an agent must
 * do scales with the disagreement rather than with the corpus. It decides nothing: agreement is
 * a prioritisation signal, and every escalation goes to someone who reads the panels' reasoning.
 *
 * Input is each panel's JSON manifest — never its prose, which the source's first version read
 * with a regex and misread a mention of another flow's process as an assignment:
 *   { "panel": "G", "flows": [ { "id", "name", "domains", "flow_type", "verdict", "gap_note",
 *     "stages": [ { "name", "processes": ["P017", …] } ] } ] }
 * The roster — the process list the panels were given — is the only honest coverage check: a
 * process every panel dropped is invisible to their union.
 */

const ROSTER_ID = /^(?:P\d+|BF-\d+(?:\.S\d+)?(?:\.P\d+)?)$/;

/** The source's sort key: how many numbers, then the numbers, then the text. */
function compareIds(a, b) {
  const numbers = (id) => (id.match(/\d+/g) ?? []).map(Number);
  const [x, y] = [numbers(a), numbers(b)];
  if (x.length !== y.length) return x.length - y.length;
  for (let index = 0; index < x.length; index += 1) if (x[index] !== y[index]) return x[index] - y[index];
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** A JSON list, a JSON object keyed by id, one id per line, or a markdown table led by the id. */
export function parseRoster(text) {
  if (/^\s*[[{]/.test(text)) {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : Object.keys(data);
  }
  return text.split("\n").map((line) => line.trim()).map((line) => (line.startsWith("|") ? line.replace(/^\|+|\|+$/g, "").split("|")[0].trim() : line)).filter((id) => ROSTER_ID.test(id));
}

export function readManifest(manifest, fallbackName) {
  const panel = { panel: manifest.panel ?? fallbackName, flowOf: new Map(), meta: new Map(), members: new Map(), dupes: [] };
  for (const flow of manifest.flows ?? []) {
    panel.meta.set(flow.id, { name: flow.name, domains: flow.domains, flow_type: flow.flow_type, verdict: flow.verdict, gap_note: flow.gap_note });
    for (const process of (flow.stages ?? []).flatMap((stage) => stage.processes ?? [])) {
      if (panel.flowOf.has(process) && panel.flowOf.get(process) !== flow.id) panel.dupes.push([process, panel.flowOf.get(process), flow.id]);
      panel.flowOf.set(process, flow.id);
      panel.members.set(flow.id, new Set([...(panel.members.get(flow.id) ?? []), process]));
    }
  }
  return panel;
}

function pairWeights(panels) {
  const weight = new Map();
  for (const panel of panels) {
    for (const processes of panel.members.values()) {
      const sorted = [...processes].sort();
      sorted.forEach((a, index) => sorted.slice(index + 1).forEach((b) => weight.set(`${a}\u0000${b}`, (weight.get(`${a}\u0000${b}`) ?? 0) + 1)));
    }
  }
  return weight;
}

/** Union-find over every pair enough panels put together; clusters in the order their first member is met. */
function clustersOf(all, { weight, minAgree }) {
  const parent = new Map(all.map((id) => [id, id]));
  const find = (id) => {
    let node = id;
    while (parent.get(node) !== node) node = parent.get(node);
    return node;
  };
  for (const [pair, count] of weight) {
    if (count < minAgree) continue;
    const [a, b] = pair.split("\u0000");
    if (find(a) !== find(b)) parent.set(find(a), find(b));
  }
  const clusters = new Map();
  for (const id of all) clusters.set(find(id), [...(clusters.get(find(id)) ?? []), id]);
  return [...clusters.values()].map((members, order) => ({ members, order })).sort((a, b) => b.members.length - a.members.length || a.order - b.order).map(({ members }) => members);
}

function clusterEntry(members, { panels, index }) {
  const perPanel = Object.fromEntries(panels.map((panel) => {
    const flows = [...new Set(members.filter((id) => panel.flowOf.has(id)).map((id) => panel.flowOf.get(id)))].sort();
    return [panel.panel, flows.map((flow) => ({ flow_id: flow, name: panel.meta.get(flow)?.name ?? "?", verdict: panel.meta.get(flow)?.verdict ?? null }))];
  }));
  return { id: `C${String(index + 1).padStart(2, "0")}`, size: members.length, processes: [...members].sort(compareIds), per_panel: perPanel };
}

/**
 * The source's result object. An escalation is a cluster touched by more distinct flows than
 * there are panels: at least one panel split what the others kept together.
 */
export function reconcilePanels(panels, { minAgree, roster }) {
  const placed = new Set(panels.flatMap((panel) => [...panel.flowOf.keys()]));
  const all = [...new Set([...placed, ...(roster ?? [])])].sort(compareIds);
  const missing = Object.fromEntries(all.map((id) => [id, panels.filter((panel) => !panel.flowOf.has(id)).map((panel) => panel.panel)]).filter(([, tags]) => tags.length > 0));
  const clusters = clustersOf(all, { weight: pairWeights(panels), minAgree }).map((members, index) => clusterEntry(members, { panels, index }));
  const distinct = (entry) => Object.values(entry.per_panel).reduce((sum, flows) => sum + flows.length, 0);
  return {
    panels: panels.map((panel) => panel.panel),
    min_agree: minAgree,
    total_processes: all.length,
    roster_size: roster ? roster.length : null,
    missing_from_every_panel: roster ? roster.filter((id) => !placed.has(id)).sort(compareIds) : [],
    missing_from_a_panel: missing,
    clusters,
    escalations: clusters.filter((entry) => distinct(entry) > panels.length),
    schema_violations: panels.flatMap((panel) => panel.dupes.map(([process, first, second]) => ({ panel: panel.panel, process, flows: [first, second] }))),
  };
}

function dataQuality(result) {
  const lines = [];
  if (result.roster_size === null) lines.push("[DATA QUALITY] no --roster given, so coverage was checked only against the union of the panels. A process every panel dropped cannot be detected this way. Re-run with --roster pointing at the source process list.", "");
  if (result.missing_from_every_panel.length > 0) lines.push(`[DATA QUALITY] ${result.missing_from_every_panel.length} process(es) in the roster appear in NO panel at all -- they were dropped by everyone, so no amount of panel agreement covers them. Each needs its own adjudication:`, ...result.missing_from_every_panel.map((id) => `   ${id} missing from every panel`), "");
  const partial = Object.entries(result.missing_from_a_panel);
  if (partial.length > 0) lines.push(`[DATA QUALITY] ${partial.length} process(es) missing from at least one panel's manifest -- that panel's coverage is incomplete, follow up before trusting its 'no leftovers' claim:`, ...partial.map(([id, tags]) => `   ${id} missing from ${JSON.stringify(tags)}`), "");
  for (const violation of result.schema_violations) lines.push(`[SCHEMA VIOLATION] panel ${violation.panel}: ${violation.process} placed in both ${violation.flows[0]} and ${violation.flows[1]}`);
  return lines;
}

function escalationLines(result) {
  if (result.escalations.length === 0) return ["No escalations -- every panel's grouping agrees at the cluster level. Pick any panel's flow name/stage breakdown as the canonical write, or synthesise across the (already-agreeing) proposals for the best names/gap notes."];
  return ["ESCALATE TO BA -- panels disagree on how these processes should be grouped (not just what to name the group):", ...result.escalations.flatMap((entry) => [
    `\n${entry.id} (${entry.size} processes: ${entry.processes.slice(0, 6).join(", ")}${entry.size > 6 ? "..." : ""})`,
    ...Object.entries(entry.per_panel).map(([panel, flows]) => `   ${panel}: ${flows.map((flow) => `${flow.flow_id} "${flow.name}" [${flow.verdict}]`).join("; ")}`),
  ])];
}

export function renderReconciliation(result) {
  return [
    `Reconciled ${result.total_processes} processes across panels ${JSON.stringify(result.panels)} (auto-accept threshold: ${result.min_agree}/${result.panels.length} panels agreeing).`,
    `Consensus clusters: ${result.clusters.length}  |  needing a human decision: ${result.escalations.length}`,
    "",
    ...dataQuality(result),
    ...escalationLines(result),
  ].join("\n");
}
