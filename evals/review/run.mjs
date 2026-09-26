#!/usr/bin/env node
// Runs reviewer designs over planted-defect fixtures and counts what each one catches (the
// skill-parity plan, "Measuring Phase A"). Dev tooling, not part of kiln: it starts headless
// Claude Code, which reaches the model API.
//
// Usage: node evals/review/run.mjs --arms kiln-rc40,sources --reps 5 --model claude-sonnet-5
//          [--fixtures 01,05] [--oss ~/.cache/kiln-oss] [--out evals/review/results/<name>]
//          [--concurrency 4] [--kiln <checkout whose kiln-review the kiln arm reads>]
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ARMS } from "./arms.mjs";
import { runClaude } from "./claude.mjs";
import { defectsOf, isFixture, materialize } from "./fixture.mjs";
import { gradePrompt, parseGrade } from "./grade.mjs";
import { renderSummary, summarize } from "./summary.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const PINS = { "agent-skills": "2686b620fc1fed2e8f60c704839c766b8594c6b6", "BMAD-METHOD": "5e33d3c03ba53187a40ab679d5479cdd4b6ac2fb" };

function option(argv, { name, fallback }) {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
}

function optionsFrom(argv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    arms: option(argv, { name: "arms", fallback: "kiln-rc40,sources" }).split(","),
    reps: Number(option(argv, { name: "reps", fallback: "5" })),
    model: option(argv, { name: "model", fallback: "claude-sonnet-5" }),
    only: option(argv, { name: "fixtures", fallback: "" }).split(",").filter(Boolean),
    oss: resolve(option(argv, { name: "oss", fallback: join(homedir(), ".cache", "kiln-oss") })),
    out: resolve(option(argv, { name: "out", fallback: join(HERE, "results", stamp) })),
    concurrency: Number(option(argv, { name: "concurrency", fallback: "4" })),
    kiln: resolve(option(argv, { name: "kiln", fallback: join(HERE, "..", "..") })),
  };
}

/** The sources' readers are read from local clones; a clone at another commit is a different arm. */
function checkPins(opts) {
  for (const [name, sha] of Object.entries(PINS)) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(opts.oss, name), encoding: "utf8" }).trim();
    if (head !== sha) throw new Error(`${name} in ${opts.oss} is at ${head.slice(0, 12)}, not the pinned ${sha.slice(0, 12)}.`);
  }
}

function fixtures(opts) {
  const root = join(HERE, "fixtures");
  return readdirSync(root).filter((name) => isFixture(join(root, name)))
    .filter((name) => opts.only.length === 0 || opts.only.some((prefix) => name.startsWith(prefix)))
    .map((name) => ({ name, dir: join(root, name) }));
}

/** A counting semaphore: at most `limit` Claude processes at once, across every job. */
function limiter(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async (task) => {
    if (active >= limit) await new Promise((wake) => waiting.push(wake));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function contextFor(job, opts) {
  const work = join(opts.out, "work", job.fixture.name, job.arm, String(job.rep));
  const ctx = materialize(job.fixture.dir, work);
  return { ...ctx, bmadSkill: join(opts.oss, "BMAD-METHOD", "skills", "bmad-code-review"), agentSkills: join(opts.oss, "agent-skills"), kilnRoot: opts.kiln };
}

async function readReports(job, env) {
  const readers = await ARMS[job.arm](job.ctx);
  return Promise.all(readers.map(async (reader) => {
    const result = await env.limit(() => runClaude({ ...reader, cwd: job.ctx.repo, model: env.opts.model }));
    return { id: reader.id, ...result };
  }));
}

async function gradeReports(job, env) {
  const prompt = gradePrompt(job.defects, job.reports);
  const result = await env.limit(() => runClaude({ prompt, cwd: job.ctx.inputs, model: env.opts.model, tools: ["Read"] }));
  return { grades: parseGrade(result.text, job.defects), cost: result.cost, raw: result.text };
}

function saveJob(job, env) {
  const dir = join(env.opts.out, "reports", job.fixture.name, job.arm, String(job.rep));
  mkdirSync(dir, { recursive: true });
  for (const report of job.reports) writeFileSync(join(dir, `${report.id.replace(/[:/]/g, "_")}.md`), report.text || `ERROR: ${report.error}`);
  writeFileSync(join(dir, "grade.json"), `${JSON.stringify(job.graded, null, 2)}\n`);
}

async function runJob(job, env) {
  const ctx = contextFor(job, env.opts);
  const withContext = { ...job, ctx, defects: defectsOf(job.fixture.dir) };
  const reports = await readReports(withContext, env);
  const graded = await gradeReports({ ...withContext, reports }, env);
  saveJob({ ...withContext, reports, graded }, env);
  process.stdout.write(`${job.fixture.name} ${job.arm} #${job.rep}: ${Object.entries(graded.grades).map(([id, grade]) => `${id}=${grade.caught}`).join(" ")}\n`);
  const cost = reports.reduce((sum, report) => sum + report.cost, graded.cost);
  return { fixture: job.fixture.name, arm: job.arm, rep: job.rep, grades: graded.grades, cost, failed: reports.filter((report) => report.error).map((report) => report.id) };
}

function jobsFor(opts) {
  return fixtures(opts).flatMap((fixture) => opts.arms.flatMap((arm) => Array.from({ length: opts.reps }, (_, rep) => ({ fixture, arm, rep: rep + 1 }))));
}

async function main(argv) {
  const opts = optionsFrom(argv);
  const unknown = opts.arms.filter((arm) => !ARMS[arm]);
  if (unknown.length > 0) throw new Error(`unknown arm(s): ${unknown.join(", ")}; known: ${Object.keys(ARMS).join(", ")}`);
  if (opts.arms.includes("sources")) checkPins(opts);
  mkdirSync(opts.out, { recursive: true });
  const env = { opts, limit: limiter(opts.concurrency) };
  const records = await Promise.all(jobsFor(opts).map((job) => runJob(job, env)));
  const summary = summarize(records, { ...opts, pins: PINS });
  writeFileSync(join(opts.out, "summary.json"), `${JSON.stringify({ summary, records }, null, 2)}\n`);
  writeFileSync(join(opts.out, "summary.md"), renderSummary(summary));
  process.stdout.write(renderSummary(summary));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
