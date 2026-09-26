import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { actualChanged, pathsOf, statusPaths } from "./blast.mjs";
import { hasStore, readStore } from "./dna/store.mjs";
import { gitOutput } from "./init.mjs";
import { PracticesError, riskFlags } from "./practices.mjs";
import { UNDETECTED, loadStack } from "./stack.mjs";
import { artifactPath, gateApproved } from "./state.mjs";

/**
 * What `kiln practices` knows about a work at a stage (D188). Anything it cannot know is
 * `null`, which a trigger reads as unknown rather than as no.
 */

const CHANGED_STAGES = new Set(["implement", "review", "ship"]);

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * A plan still being written must say its Risk flags before practices are routed from it. A
 * plan already approved without the section — written before D188 — keeps its approval:
 * adding the section would change what the gate hashed, so its flags are unknown instead.
 */
function flagsOf(root, { state, stage }) {
  const plan = readIfPresent(artifactPath(root, { id: state.id, key: "plan" }));
  if (plan === null && stage === "plan") throw new PracticesError(`plan.md does not exist yet. Write its header, with the "## Risk flags" section, first — the practices for PLAN are chosen from those flags — then run this again.`);
  if (plan === null) return null;
  const flags = riskFlags(plan);
  if (flags !== null || gateApproved(state, "plan")) return flags;
  throw new PracticesError(`plan.md has no "## Risk flags" section. Write it first — one "- <flag>: <why>" line per flag, or "- none" — then run this again.`);
}

function stageFiles(root, { state, stage, predicted }) {
  if (stage === "investigate") return [...new Set((state.knowledge ?? []).flatMap((asked) => asked.files ?? []))];
  if (stage === "plan") return predicted.length > 0 ? predicted : pathsOf(state.predicted);
  const changed = actualChanged(root, state.base);
  // IMPLEMENT starts before anything has changed: what the plan gate approved is what it works on.
  return stage === "implement" ? [...new Set([...pathsOf(state.predicted), ...changed])].sort() : changed;
}

/** Added lines per file, from one `git diff -U0` against the base, plus every untracked file whole. */
function addedText(root, { base, files }) {
  const added = new Map();
  let file = null;
  for (const line of (gitOutput(root, ["diff", "-U0", "--no-color", "--no-ext-diff", base]) ?? "").split("\n")) {
    if (line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6) : null;
    else if (file && line.startsWith("+")) added.set(file, `${added.get(file) ?? ""}${line.slice(1)}\n`);
  }
  for (const path of files.filter((each) => !added.has(each))) added.set(path, readIfPresent(join(root, path)) ?? "");
  return added;
}

/** Changed lines, counting a file git does not track by its whole length. */
function changedLines(root, { base, added }) {
  const numstat = (gitOutput(root, ["diff", "--numstat", base]) ?? "").split("\n").filter(Boolean);
  const tracked = numstat.reduce((sum, row) => sum + row.split("\t").slice(0, 2).map(Number).filter(Number.isFinite).reduce((a, b) => a + b, 0), 0);
  const untracked = statusPaths(root).filter((path) => !numstat.some((row) => row.endsWith(`\t${path}`)));
  return tracked + untracked.reduce((sum, path) => sum + (added.get(path) ?? "").split("\n").filter(Boolean).length, 0);
}

function stackKinds(root, { stackId, files }) {
  if (!stackId || stackId === UNDETECTED) return null;
  const rules = (loadStack(stackId).dna?.surfaces ?? []).map((rule) => ({ kind: rule.kind, path: new RegExp(rule.files), text: rule.contains ? new RegExp(rule.contains, "m") : null }));
  if (rules.length === 0) return null;
  const kinds = new Map();
  for (const file of files) {
    const text = rules.some((rule) => rule.text) ? readIfPresent(join(root, file)) ?? "" : "";
    const rule = rules.find((each) => each.path.test(file) && (!each.text || each.text.test(text)));
    if (rule) kinds.set(file, rule.kind);
  }
  return kinds;
}

/** The DNA store's surfaces are the second source: a file one of them names has that surface's kind. */
function storeKinds(root, files) {
  if (!hasStore(root)) return null;
  const kinds = new Map();
  for (const surface of readStore(root).data.surfaces ?? []) {
    for (const path of surface.primary_paths ?? []) if (files.includes(path)) kinds.set(path, surface.kind);
  }
  return kinds;
}

function kindsOf(root, { config, files }) {
  const fromStack = stackKinds(root, { stackId: config.stack?.id, files });
  const fromStore = storeKinds(root, files);
  if (fromStack === null && fromStore === null) return null;
  return new Map([...(fromStore ?? []), ...(fromStack ?? [])]);
}

export function gatherFacts(root, { config, state, stage, predicted = [] }) {
  const files = stageFiles(root, { state, stage, predicted });
  const facts = { path: state.path, auto: state.auto === true, flags: flagsOf(root, { state, stage }), files, lines: null, added: null, kinds: kindsOf(root, { config, files }) };
  if (!CHANGED_STAGES.has(stage)) return facts;
  const added = addedText(root, { base: state.base, files });
  return { ...facts, added, lines: changedLines(root, { base: state.base, added }) };
}
