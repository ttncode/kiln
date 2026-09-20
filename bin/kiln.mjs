#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyInit, planInit, proposeConfig } from "../lib/init.mjs";

/** A work id may never take one of these, or `work/dna/` would shadow the command (D79). */
export const RESERVED = Object.freeze(["init", "doctor", "dna"]);

const USAGE = `kiln — one unit of work to a reviewed pull request

  kiln init [--propose] [--set <key>=<value> ...]
      Detect the stack and write .kiln/. Overwrites nothing.
      --propose  print the proposed config and its questions; write nothing.
      --set      override one dotted key, e.g. --set stack.cmd.test="npm test".
`;

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** Config is a file the agent may not write (D48), so answers arrive as arguments. */
export function setPath(target, assignment) {
  const separator = assignment.indexOf("=");
  if (separator < 1) throw new Error(`--set expects <key>=<value>, got: ${assignment}`);
  const keys = assignment.slice(0, separator).split(".");
  const raw = assignment.slice(separator + 1);
  const leaf = keys.pop();

  let node = target;
  for (const key of keys) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[leaf] = raw.includes(",") ? raw.split(",").map((part) => part.trim()) : raw;
  return target;
}

function applyOverrides(config, argv) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "--set") setPath(config, argv[i + 1]);
  }
  return config;
}

function reportInit(result) {
  for (const path of result.kept) out(`  kept    ${path}`);
  for (const path of result.written) out(`  wrote   ${path}`);
  out(result.written.length > 0 ? "\nRun `kiln doctor` to check it." : "\nAlready set up. Run `kiln doctor --write` to repair paths.");
}

function runInit(argv) {
  const root = process.cwd();
  const { config, questions, detected } = proposeConfig(root);
  if (argv.includes("--propose")) {
    out(JSON.stringify({ config, questions, detected }, null, 2));
    return 0;
  }
  out(`stack: ${detected.stack.id}${detected.stack.evidence ? ` (${detected.stack.evidence})` : ""}`);
  out(`integration branch: ${detected.vcs.integration_branch}`);
  out(`${planInit(root).missing.length} file(s) to write`);
  reportInit(applyInit(root, applyOverrides(config, argv)));
  return 0;
}

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === "init") return runInit(rest);
  out(USAGE);
  return command === undefined || command === "--help" ? 0 : 1;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
