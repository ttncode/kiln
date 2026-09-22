#!/usr/bin/env node
/**
 * B06: every point a user must answer between `kiln init` and their first pull request.
 *
 * The machine half of "first-run survival". The judgment half is a person's, and a person
 * who built the thing cannot supply it — but the count is not a judgment, and a release
 * that quietly doubles it should not be able to do so unnoticed.
 *
 * Counted: the questions `init` asks a project of this shape, and the gates the path stops
 * at. Not counted: a halt, which is conditional, and the ratchet, which is a choice the
 * user may never be offered.
 *
 * Usage: node scripts/decision-count.mjs [<project>]
 */
import { PATHS, ceremonyFor } from "../lib/ceremony.mjs";
import { proposeConfig } from "../lib/init.mjs";

export function decisionsToFirstPR(root) {
  const asked = proposeConfig(root).questions;
  return PATHS.filter((path) => ceremonyFor(path).ships).map((path) => ({
    path,
    asked: asked.length,
    gates: ceremonyFor(path).gates.length,
    total: asked.length + ceremonyFor(path).gates.length,
  }));
}

if (process.argv[1]?.endsWith("decision-count.mjs")) {
  const root = process.argv[2] ?? process.cwd();
  for (const row of decisionsToFirstPR(root)) {
    process.stdout.write(`${row.path.padEnd(8)} ${row.total}  (${row.asked} asked by init + ${row.gates} gates)\n`);
  }
}
