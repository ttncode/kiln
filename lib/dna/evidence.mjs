import { contents, hasCommit, measure, repositories, treeAt } from "./scan.mjs";
import { DnaError } from "./store.mjs";

/**
 * D174: a citation is checked where it is written. tps-project-dna makes `ref` relative to the
 * evidence source `src` names (dna-store.md), as SARIF resolves `uri` against `uriBaseId`; SARIF's
 * validator refuses an end line before its start (SARIF1007). Neither checks that the file is
 * there, and the source records a wrong-file citation only a sampled audit caught — so for
 * code, kiln also opens the file at the round's commit and holds the range to its length.
 */

const LOC = /^L(\d+)(?:-L(\d+))?$/;

/** A finding's citation is what a scanner writes, so it must have the shape; other records' evidence is checked where it names a source. */
function citations(upsert) {
  return Object.entries(upsert ?? {}).flatMap(([name, records]) => records.flatMap((record) => (Array.isArray(record.evidence) ? record.evidence : [])
    .map((cite) => ({ record: record.id ?? record.key ?? "a new record", cite, finding: name === "findings" }))))
    .filter(({ cite, finding }) => finding || (cite && typeof cite === "object" && cite.src !== undefined));
}

const isCitation = (cite) => cite !== null && typeof cite === "object" && typeof cite.src === "string" && typeof cite.ref === "string";

function locProblem(loc) {
  if (loc === undefined) return null;
  const match = LOC.exec(String(loc));
  if (!match) return `loc "${loc}" is not L<from> or L<from>-L<to>`;
  const [from, to] = [Number(match[1]), Number(match[2] ?? match[1])];
  return from >= 1 && from <= to ? null : `loc "${loc}" runs backwards or starts before line 1`;
}

/** The repositories a citation can name, each at the commit asked for when this clone holds it, else the tip. */
function codeSources(root, { config, commits }) {
  if (!config) return new Map();
  return new Map(repositories(root, config).map((repo) => {
    const asked = commits[repo.name];
    return [repo.name, { ...repo, commit: asked && hasCommit(repo.dir, asked) ? asked : repo.commit }];
  }));
}

function lineCounts(repo, refs) {
  const tree = treeAt({ ...repo, path: "" });
  const bytes = contents(repo.dir, [...new Set(refs.map((ref) => tree.get(ref)).filter(Boolean))]);
  return new Map(refs.filter((ref) => tree.has(ref)).map((ref) => [ref, measure(bytes.get(tree.get(ref))?.toString("utf8") ?? "").total]));
}

function codeProblem(cite, { repo, lines }) {
  if (!lines.has(cite.ref)) {
    const hint = repo.path && String(cite.ref).startsWith(`${repo.path}/`) ? ` — ref is relative to ${repo.name}, so drop "${repo.path}/"` : "";
    return `${repo.name} at ${repo.commit.slice(0, 12)} has no file ${cite.ref}${hint}`;
  }
  const end = Number(LOC.exec(String(cite.loc ?? ""))?.slice(1).filter(Boolean).pop() ?? 0);
  return end > lines.get(cite.ref) ? `loc ${cite.loc} runs past the ${lines.get(cite.ref)} line(s) of ${cite.ref}` : null;
}

/** A document source's `loc` is its own kind of anchor (a section, a comment), so only code is held to line numbers. */
function problemsOf(found, { sources, declared, counted }) {
  if (!isCitation(found.cite)) return `a finding's evidence is { src, ref, loc }, not ${JSON.stringify(found.cite)}`;
  const repo = sources.get(found.cite.src);
  if (repo) return locProblem(found.cite.loc) ?? codeProblem(found.cite, { repo, lines: counted.get(repo.name) });
  if (declared.has(found.cite.src) || sources.size === 0) return null;
  return `src "${found.cite.src}" is neither a repository (${[...sources.keys()].join(", ")}) nor a declared evidence source`;
}

/** Every citation in `records` (collection name to records) that does not resolve, with why. */
export function unresolvedCitations(root, { records, settings, config, commits = {} }) {
  const found = citations(records);
  if (found.length === 0) return [];
  const sources = codeSources(root, { config, commits });
  const declared = new Set((settings.evidence_sources ?? []).map((source) => source.id));
  const counted = new Map([...sources.values()].map((repo) => [repo.name, lineCounts(repo, found.filter(({ cite }) => cite.src === repo.name).map(({ cite }) => String(cite.ref)))]));
  return found.map((each) => ({ record: each.record, problem: problemsOf(each, { sources, declared, counted }) })).filter((each) => each.problem);
}

/**
 * D178: outside a scan round a citation is good if it resolves at the store's pins — what the
 * store describes — or at the tip, since pins move only when a round was read at the tip and so
 * can trail what was read. Only one that resolves at neither is a problem.
 */
export function unresolvedAtPinsOrTip(root, { records, settings, config, pins }) {
  const atPins = unresolvedCitations(root, { records, settings, config, commits: pins ?? {} });
  if (atPins.length === 0) return [];
  const atTip = new Set(unresolvedCitations(root, { records, settings, config }).map((each) => each.record));
  return atPins.filter((each) => atTip.has(each.record));
}

export function checkEvidence(root, { batch, settings, config, pins }) {
  const records = batch.upsert;
  const bad = batch.scan ? unresolvedCitations(root, { records, settings, config, commits: batch.scan.commits ?? {} }) : unresolvedAtPinsOrTip(root, { records, settings, config, pins });
  if (bad.length === 0) return;
  throw new DnaError(`${bad.length} citation(s) do not resolve; nothing was written:\n${bad.map((each) => `  ${each.record}: ${each.problem}`).join("\n")}`);
}
