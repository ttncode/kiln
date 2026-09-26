#!/usr/bin/env node
// Runs kiln the way a user does — `/kiln:kiln init`, then a ticket — in real Claude Code
// sessions on a copy of a sample project, with a simulated user answering its questions, and
// checks what that user would check afterwards. Dev tooling, not part of kiln; it starts
// headless Claude Code, which reaches the model API.
//
// Usage: node evals/e2e/run.mjs [--scenarios id,id] [--kiln <checkout>] [--model claude-sonnet-5]
//          [--user-model claude-sonnet-5] [--budget 30] [--turns 12] [--out evals/e2e/results/<name>]
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scenarioChecks } from "./checks.mjs";
import { runTurn } from "./session.mjs";
import { userReply } from "./user.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const IDENTITY = ["-c", "user.name=Ana Developer", "-c", "user.email=ana@agency.test", "-c", "commit.gpgsign=false"];
const INIT_PERSONA = "You are the agency developer setting kiln up on this repository for the first time. Accept kiln's detected defaults unless they are clearly wrong.";

function option(argv, { name, fallback }) {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
}

function optionsFrom(argv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    only: option(argv, { name: "scenarios", fallback: "" }).split(",").filter(Boolean),
    kiln: resolve(option(argv, { name: "kiln", fallback: join(HERE, "..", "..") })),
    model: option(argv, { name: "model", fallback: "claude-sonnet-5" }),
    userModel: option(argv, { name: "user-model", fallback: "claude-sonnet-5" }),
    budget: Number(option(argv, { name: "budget", fallback: "30" })),
    turns: Number(option(argv, { name: "turns", fallback: "12" })),
    out: resolve(option(argv, { name: "out", fallback: join(HERE, "results", stamp) })),
  };
}

function git(repo, args) {
  return execFileSync("git", [...IDENTITY, ...args], { cwd: repo, encoding: "utf8" }).trim();
}

/** A fresh copy of the sample project, committed on main, with a bare origin to push to. */
function freshProject(dir) {
  const repo = join(dir, "tasktrack");
  const origin = join(dir, "origin.git");
  cpSync(join(HERE, "project"), repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "tasktrack 0.3.0"]);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "origin", "main"]);
  return repo;
}

/** One conversation: the opening prompt, then the simulated user's replies until it says DONE. */
async function converse(conversation, env) {
  const { repo, prompt, persona, ticket, transcript } = conversation;
  const log = [];
  let turn = await runTurn({ cwd: repo, kiln: env.opts.kiln, model: env.opts.model, budget: env.opts.budget, prompt, transcript });
  const toolUses = [...turn.toolUses];
  let cost = turn.cost;
  for (let count = 1; count < env.opts.turns; count += 1) {
    log.push({ assistant: turn.lastText });
    const reply = await userReply({ scenario: { persona, ticket }, message: turn.lastText, model: env.opts.userModel });
    log.push({ user: reply });
    if (reply === "DONE" || !turn.sessionId) break;
    turn = await runTurn({ cwd: repo, kiln: env.opts.kiln, model: env.opts.model, budget: env.opts.budget, prompt: reply, transcript, resume: turn.sessionId });
    toolUses.push(...turn.toolUses);
    cost = Math.max(cost, turn.cost);
  }
  return { log, toolUses, cost };
}

async function runScenario(scenario, env) {
  const dir = join(env.opts.out, scenario.id);
  mkdirSync(dir, { recursive: true });
  const repo = freshProject(dir);
  const init = await converse({ repo, prompt: "/kiln:kiln init", persona: INIT_PERSONA, ticket: "/kiln:kiln init", transcript: join(dir, "init.jsonl") }, env);
  const work = await converse({ repo, prompt: scenario.ticket, persona: scenario.persona, ticket: scenario.ticket, transcript: join(dir, "ticket.jsonl") }, env);
  const checks = scenarioChecks(repo, { expect: scenario.expect, toolUses: work.toolUses });
  const record = { id: scenario.id, cost: Number((init.cost + work.cost).toFixed(2)), checks, conversation: [...init.log, ...work.log] };
  writeFileSync(join(dir, "result.json"), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${scenario.id}: ${checks.filter((each) => each.ok).length}/${checks.length} checks, $${record.cost}\n`);
  return record;
}

function report(records) {
  return records.map((record) => [`## ${record.id} — $${record.cost}`, "", ...record.checks.map((each) => `- ${each.ok ? "✅" : "❌"} ${each.name}${each.detail ? ` — ${each.detail}` : ""}`), ""].join("\n")).join("\n");
}

async function main(argv) {
  const opts = optionsFrom(argv);
  const scenarios = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8")).filter((scenario) => opts.only.length === 0 || opts.only.includes(scenario.id));
  mkdirSync(opts.out, { recursive: true });
  const records = await Promise.all(scenarios.map((scenario) => runScenario(scenario, { opts })));
  writeFileSync(join(opts.out, "report.md"), `# kiln end-to-end — ${new Date().toISOString()}\n\n${report(records)}`);
  process.stdout.write(report(records));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
