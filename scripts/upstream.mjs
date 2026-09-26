#!/usr/bin/env node
// What superpowers, agent-skills and BMAD have changed since kiln copied from them (D186) — the
// release-checklist step every copy costs, as dna-upstream.mjs is for the DNA method (D167).
// Adopt what is worth adopting as a decision entry, never as a merge (D69).
//
// Reads local checkouts; reaches no network.
//
// Usage: node scripts/upstream.mjs report <dir holding agent-skills/, superpowers/, BMAD-METHOD/>
//        node scripts/upstream.mjs record <same dir>   — fill the hashes in skills/copies.json
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCES, copyBody, sha256 } from "../lib/copies.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST = join(ROOT, "skills", "copies.json");

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
}

function checkout(oss, entry) {
  return join(oss, SOURCES[entry.source]);
}

function upstreamAt(oss, { entry, commit }) {
  return git(checkout(oss, entry), ["show", `${commit}:${entry.from}`]);
}

function recorded(oss, entry) {
  const upstream = sha256(upstreamAt(oss, { entry, commit: entry.commit }));
  const kiln = sha256(copyBody(readFileSync(join(ROOT, entry.path), "utf8")));
  if (entry.kind === "verbatim" && kiln !== upstream) throw new Error(`${entry.path} is recorded as verbatim but its body differs from ${entry.source}:${entry.from}`);
  return { ...entry, upstream_sha256: upstream, kiln_sha256: kiln };
}

function drift(oss, entry) {
  const now = sha256(upstreamAt(oss, { entry, commit: "HEAD" }));
  return now === entry.upstream_sha256 ? null : `  changed upstream: ${entry.source}:${entry.from} → ${entry.path} (${entry.kind}) — read the diff since ${entry.commit.slice(0, 12)}`;
}

function report(oss, entries) {
  const lines = entries.map((entry) => drift(oss, entry)).filter(Boolean);
  const heads = Object.entries(SOURCES).map(([name, dir]) => `${name} ${git(join(oss, dir), ["log", "-1", "--format=%h %cs", "HEAD"]).trim()}`);
  process.stdout.write(`${entries.length} copies; checkouts at ${heads.join(", ")}.\n`);
  process.stdout.write(lines.length === 0 ? "Nothing kiln copies has changed upstream.\n" : `${lines.join("\n")}\nAdopt what is worth adopting as a decision entry, never as a merge.\n`);
}

const [verb, oss] = process.argv.slice(2);
const entries = JSON.parse(readFileSync(MANIFEST, "utf8"));
if (!oss || !["report", "record"].includes(verb)) {
  console.error("usage: node scripts/upstream.mjs report|record <dir holding the three checkouts>");
  process.exit(2);
}
if (verb === "record") writeFileSync(MANIFEST, `${JSON.stringify(entries.map((entry) => recorded(oss, entry)), null, 2)}\n`);
else report(oss, entries);
