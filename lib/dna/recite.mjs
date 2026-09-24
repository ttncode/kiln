import { unresolvedAtPinsOrTip } from "./evidence.mjs";
import { hasCommit, repositories } from "./scan.mjs";

/**
 * D178: citations already in a store are judged too, the way a tightened validator meets old
 * data — ESLint reports existing violations as warnings and fixes only what is mechanical,
 * SARIF Multitool keeps `validate` apart from `rewrite`, and tps-project-dna grandfathers old
 * evidence with a warning and migrates the store rather than coercing at read time. New writes
 * stay blocked by D174; what is already there is reported by `kiln dna check`, judged at the
 * commits the store is pinned to, and `kiln dna recite` rewrites the unambiguous cases.
 */

const TIGHT_LOC = /^L(\d+)-(\d+)$/;

/** Findings a round retired describe code that is gone; their citations are history, not claims. */
function liveRecords(data) {
  const retired = new Set(data.excluded.filter((entry) => entry.catalog === "RETIRED").flatMap((entry) => entry.rd_ids ?? []));
  return Object.fromEntries(Object.entries(data)
    .filter(([name]) => name !== "edges")
    .map(([name, rows]) => [name, name === "findings" ? rows.filter((row) => !retired.has(row.id)) : rows]));
}

export function storeCitationProblems(root, { store, config }) {
  return unresolvedAtPinsOrTip(root, { records: liveRecords(store.data), settings: store.settings, config, pins: store.manifest?.source_pins });
}

/** Pins this clone does not hold — a shallow clone, a gc, a force-push — whose citations were judged at the tip instead. */
export function missingPins(root, { store, config }) {
  const pins = store.manifest?.source_pins ?? {};
  return repositories(root, config).filter((repo) => pins[repo.name] && !hasCommit(repo.dir, pins[repo.name])).map((repo) => `${repo.name} ${pins[repo.name].slice(0, 12)}`);
}

/**
 * The rewrites that have one right answer: a `src` written as its repository's directory becomes
 * the repository's name, a `ref` carrying a module's directory moves to that module and loses the
 * directory, and `L12-30` becomes `L12-L30`. Anything else — a missing file, a range past the
 * end, free text — needs a reader.
 */
function owningRepo(cite, repos) {
  const named = repos.find((each) => each.name === cite.src) ?? repos.find((each) => (each.path || ".") === cite.src);
  if (named?.path) return named;
  const inner = [...repos].filter((each) => each.path && cite.ref.startsWith(`${each.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return inner ?? named;
}

function mechanical(cite, repos) {
  if (!cite || typeof cite !== "object" || typeof cite.src !== "string" || typeof cite.ref !== "string") return cite;
  const repo = owningRepo(cite, repos);
  if (!repo) return cite;
  const ref = repo.path && cite.ref.startsWith(`${repo.path}/`) ? cite.ref.slice(repo.path.length + 1) : cite.ref;
  const loc = typeof cite.loc === "string" ? cite.loc.replace(TIGHT_LOC, "L$1-L$2") : cite.loc;
  return { ...cite, src: repo.name, ref, loc };
}

function candidates(store, { broken, repos }) {
  return Object.entries(liveRecords(store.data)).flatMap(([name, rows]) => rows
    .filter((row) => broken.has(row.id) && Array.isArray(row.evidence))
    .map((row) => ({ name, id: row.id, evidence: row.evidence.map((cite) => mechanical(cite, repos)) }))
    .filter((row) => JSON.stringify(row.evidence) !== JSON.stringify(store.data[name].find((each) => each.id === row.id).evidence)));
}

function asUpsert(rows) {
  const upsert = {};
  for (const row of rows) (upsert[row.name] ??= []).push({ id: row.id, evidence: row.evidence });
  return upsert;
}

/**
 * A record is rewritten only when it does not resolve now and every citation of it resolves
 * after the rewrite — so a path that merely looks like it carries its directory is left alone.
 * One still broken is reported as it would stand after the rewrite, which is what a reader fixes.
 */
export function recitePlan(root, { store, config }) {
  const problems = storeCitationProblems(root, { store, config });
  const repos = repositories(root, config);
  const proposed = candidates(store, { broken: new Set(problems.map((each) => each.record)), repos });
  const after = unresolvedAtPinsOrTip(root, { records: asUpsert(proposed), settings: store.settings, config, pins: store.manifest?.source_pins });
  const still = new Set(after.map((each) => each.record));
  const fixed = proposed.filter((row) => !still.has(row.id));
  const done = new Set(fixed.map((row) => row.id));
  const rewritten = new Set(after.map((each) => each.record));
  const leftover = [...problems.filter((each) => !done.has(each.record) && !rewritten.has(each.record)), ...after];
  return { batch: { upsert: asUpsert(fixed) }, fixed: fixed.map((row) => row.id), leftover: [...new Map(leftover.map((each) => [`${each.record} ${each.problem}`, each])).values()] };
}
