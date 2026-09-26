import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The review kiln-review runs today (D189), built the way the agent builds it: the readers are
 * the ones `lib/practices.mjs` selects for this change, and each launch prompt is filled from
 * readers.md itself, so the arm measures the document the agent reads, not a copy of it.
 * `kilnRoot` is the checkout whose skills are measured.
 */

function diffFacts(patch) {
  const added = new Map();
  let file = null;
  let lines = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6) : null;
    else if (line.startsWith("--- ")) continue;
    else if (file && (line.startsWith("+") || line.startsWith("-"))) {
      lines += 1;
      if (line.startsWith("+")) added.set(file, `${added.get(file) ?? ""}${line.slice(1)}\n`);
    }
  }
  return { files: [...added.keys()], lines, added };
}

/** The fenced block under the first heading that starts with `title`. */
function fencedUnder(readers, title) {
  const at = readers.indexOf(`\n## ${title}`);
  return /```\n([\s\S]*?)\n```/.exec(readers.slice(at))[1];
}

function lensBody(dir, name) {
  const text = readFileSync(join(dir, "lenses", name), "utf8");
  return text.slice(text.indexOf("\n\n") + 2).trim();
}

const PERSONA_LINE = /^- \*\*(code-reviewer|security-auditor|test-engineer):\*\* (.+)$/gm;

function personaPrompt(readers, persona) {
  const lines = Object.fromEntries([...readers.matchAll(PERSONA_LINE)].map((match) => [match[1], match[2]]));
  return fencedUnder(readers, "code-review-specialist").replace("<persona>", persona).replace("<the persona's line below>", lines[persona]);
}

function reviewerPrompt(dir, ctx) {
  const template = readFileSync(join(dir, "code-reviewer.md"), "utf8");
  const block = /prompt: \|\n([\s\S]*?)\n```\n/.exec(template)[1].replace(/^ {4}/gm, "");
  return block.replaceAll("[DESCRIPTION]", ctx.claims).replaceAll("[PLAN_OR_REQUIREMENTS]", ctx.plan).replaceAll("[BASE_SHA]", ctx.base);
}

function promptFor(id, env) {
  const { dir, readers, ctx } = env;
  const prompts = {
    reviewer: () => reviewerPrompt(dir, ctx),
    "blind-hunter": () => lensBody(dir, "blind-hunter.md"),
    "edge-case-hunter": () => fencedUnder(readers, "edge-case-hunter"),
    "verification-gap": () => fencedUnder(readers, "verification-gap"),
    "intent-alignment": () => lensBody(dir, "intent-alignment.md").replace("{verbatim_intent}", env.intent),
    "code-review-specialist": () => personaPrompt(readers, "code-reviewer"),
    "security-auditor": () => personaPrompt(readers, "security-auditor"),
    "test-engineer": () => personaPrompt(readers, "test-engineer"),
    performance: () => fencedUnder(readers, "performance"),
  };
  return prompts[id]();
}

function filled(text, env) {
  return text.replaceAll("{dir}", env.dir).replaceAll("{diff_file}", env.ctx.diffFile).replaceAll("{claims_file}", env.claimsFile).replaceAll("{intent_file}", env.intentFile).replaceAll("{base}", env.ctx.base);
}

/** kiln's claims are the plan and the ledger; its intent is the brief and the plan's goal (lib/review-inputs.mjs). */
function kilnInputs(ctx) {
  const claimsFile = join(ctx.inputs, "kiln-claims.md");
  const intentFile = join(ctx.inputs, "kiln-intent.md");
  const goal = /^\*\*Goal:\*\*.*$/m.exec(ctx.plan)?.[0] ?? "";
  writeFileSync(claimsFile, `## The plan\n\n${ctx.plan}\n\n## The ledger\n\n${ctx.claims}\n`);
  const intent = `## What was asked (the brief)\n\n${ctx.request}\n\n## The plan's goal\n\n${goal}\n`;
  writeFileSync(intentFile, intent);
  return { claimsFile, intentFile, intent };
}

export async function kilnReaders(ctx) {
  const { loadPractices, riskFlags, selectPractices } = await import(join(ctx.kilnRoot, "lib", "practices.mjs"));
  const dir = join(ctx.kilnRoot, "skills", "kiln-review");
  const facts = { path: "bounded", auto: false, flags: riskFlags(ctx.plan), kinds: null, ...diffFacts(readFileSync(ctx.diffFile, "utf8")) };
  const selected = selectPractices(loadPractices(ctx.kilnRoot), { stage: "review", facts }).filter((practice) => practice.reader);
  const env = { dir, ctx, readers: readFileSync(join(dir, "readers.md"), "utf8"), ...kilnInputs(ctx) };
  return selected.map((practice) => ({ id: `kiln:${practice.id}`, prompt: filled(promptFor(practice.id, env), env), addDirs: [ctx.inputs, dir] }));
}
