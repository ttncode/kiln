import { execFileSync } from "node:child_process";
import { hasCommit, repositories } from "./scan.mjs";

/**
 * D182: a store's citations are read at its pins, so a round that moves a pin moves every
 * citation in that repository with it — and code the round inserted above a cited line leaves
 * the citation pointing at other code while every check still passes. On the first real update
 * 35 of 142 citations in the changed files were off. Code review tools solved the same problem
 * for comments on a moving diff: GitLab's position tracer and Gerrit's comment porting map a
 * line through the hunks between the two commits, and a line inside a changed hunk has no
 * mapping, so it is marked outdated instead of guessed. kiln does the same for citations.
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const LOC = /^L(\d+)(?:-L(\d+))?$/;

function hunkOf(match) {
  return { start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]), added: match[3] === undefined ? 1 : Number(match[3]) };
}

/** Each changed path's hunks between two commits, in the old file's line numbers. */
function hunksBetween(dir, { from, to }) {
  const args = ["-c", "core.quotePath=false", "diff", "--no-renames", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "-U0", from, to];
  const hunks = new Map();
  let path = null;
  for (const line of execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 30 }).split("\n")) {
    if (line.startsWith("--- ")) path = line.startsWith("--- a/") ? line.slice(6) : null;
    const match = HUNK.exec(line);
    if (match && path !== null) hunks.set(path, [...(hunks.get(path) ?? []), hunkOf(match)]);
  }
  return hunks;
}

/** `-s,0` inserts after line s; any other hunk replaces lines s to s+count-1. */
function sideOf(hunk, range) {
  if (hunk.count === 0) return hunk.start < range.from ? "before" : hunk.start >= range.to ? "after" : "inside";
  return hunk.start + hunk.count - 1 < range.from ? "before" : hunk.start > range.to ? "after" : "inside";
}

function carriedRange(range, hunks) {
  let shift = 0;
  for (const hunk of hunks) {
    const side = sideOf(hunk, range);
    if (side === "inside") return null;
    if (side === "before") shift += hunk.added - hunk.count;
  }
  return { from: range.from + shift, to: range.to + shift };
}

function carryCite(cite, moved) {
  const hunks = moved.get(cite?.src)?.get(cite.ref);
  const match = LOC.exec(String(cite?.loc ?? ""));
  if (!hunks || !match) return { cite };
  const range = carriedRange({ from: Number(match[1]), to: Number(match[2] ?? match[1]) }, hunks);
  if (!range) return { cite, touched: true };
  return { cite: { ...cite, loc: match[2] === undefined ? `L${range.from}` : `L${range.from}-L${range.to}` }, shifted: range.from !== Number(match[1]) };
}

function carryRecord(record, { moved, report }) {
  if (!Array.isArray(record.evidence)) return record;
  const results = record.evidence.map((cite) => carryCite(cite, moved));
  if (results.some((each) => each.touched)) report.touched.push(record.id);
  if (results.some((each) => each.shifted)) report.moved += 1;
  return { ...record, evidence: results.map((each) => each.cite) };
}

/** The hunks of every repository whose pin this round moves, by repository name then path. */
export function movedPins(root, { config, from, to }) {
  const moved = new Map();
  if (!config || Object.keys(to).length === 0) return moved;
  for (const repo of repositories(root, config).filter((each) => from[each.name] && to[each.name] && from[each.name] !== to[each.name])) {
    if (hasCommit(repo.dir, from[repo.name])) moved.set(repo.name, hunksBetween(repo.dir, { from: from[repo.name], to: to[repo.name] }));
  }
  return moved;
}

/** Records as they stand before a batch's own upserts, which cite the new commit themselves. */
export function carryCitations(data, moved) {
  const report = { moved: 0, touched: [] };
  if (moved.size === 0) return { data, report };
  const carried = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, name === "edges" ? rows : rows.map((row) => carryRecord(row, { moved, report }))]));
  return { data: carried, report };
}
