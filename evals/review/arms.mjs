import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Each arm is the set of readers one reviewer design would dispatch for a change. A reader is
 * a prompt and, for a persona, the system prompt it runs under. The sources' readers are their
 * own text, with only the runtime placeholders their orchestrators fill filled in.
 */

const HERE = new URL(".", import.meta.url).pathname;

/** What BMAD's step-02 does before launching a lens: the child's prompt is the text after this line. */
const LAUNCH_LINE = /^Launch a (?:context-free )?subagent with this prompt:\s*\n/;

function lensBlocks(toml) {
  const sections = toml.split("[[workflow.thorough_lenses]]").slice(1);
  return sections.map((section) => ({
    id: /^id = "([^"]+)"/m.exec(section)[1],
    text: /instruction = """\n([\s\S]*?)"""/.exec(section)[1].replace(LAUNCH_LINE, "").trim(),
  }));
}

function fillLens(text, ctx) {
  return text
    .replaceAll("{diff_file}", ctx.diffFile)
    .replaceAll("{claims_file}", ctx.claimsFile)
    .replaceAll("{plan_file}", ctx.planFile)
    .replaceAll("{skill-root}", ctx.bmadSkill)
    .replaceAll("{verbatim_intent}", ctx.request);
}

function bmadThorough(ctx) {
  const toml = readFileSync(join(ctx.bmadSkill, "customize.toml"), "utf8");
  return lensBlocks(toml).map((lens) => ({ id: `bmad:${lens.id}`, prompt: fillLens(lens.text, ctx), addDirs: [ctx.inputs, ctx.bmadSkill] }));
}

/** agent-skills' `/ship` Phase A, one line per persona, verbatim. */
const SHIP_TASKS = {
  "code-reviewer": "Run a five-axis review (correctness, readability, architecture, security, performance) on the staged changes or recent commits. Output the standard review template.",
  "security-auditor": "Run a vulnerability and threat-model pass. Check OWASP Top 10, secrets handling, auth/authz, dependency CVEs. Output the standard audit report.",
  "test-engineer": "Analyze test coverage for the change. Identify gaps in happy path, edge cases, error paths, and concurrency scenarios. Output the standard coverage analysis.",
};

function withoutFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Where the change is: kiln's tree is uncommitted, so "staged changes or recent commits" is said concretely. */
function changeLocation(ctx) {
  return `The change is uncommitted in this repository, against base commit ${ctx.base}: \`git diff ${ctx.base}\` and \`git status --short\` show it, and the same unified diff is at ${ctx.diffFile}.`;
}

function shipPersonas(ctx) {
  return Object.entries(SHIP_TASKS).map(([name, task]) => ({
    id: `agent-skills:${name}`,
    system: withoutFrontmatter(readFileSync(join(ctx.agentSkills, "agents", `${name}.md`), "utf8")),
    prompt: `${task}\n\n${changeLocation(ctx)}`,
    addDirs: [ctx.inputs],
  }));
}

/** kiln-review's dispatch at rc.40: the template's prompt block, dedented, with its placeholders filled. */
function kilnRc40(ctx) {
  const template = readFileSync(join(HERE, "arms", "kiln-rc40-code-reviewer.md"), "utf8");
  const block = /prompt: \|\n([\s\S]*?)\n```\n/.exec(template)[1].replace(/^ {4}/gm, "");
  const prompt = block.replaceAll("[DESCRIPTION]", ctx.claims).replaceAll("[PLAN_OR_REQUIREMENTS]", ctx.plan).replaceAll("[BASE_SHA]", ctx.base);
  return [{ id: "kiln:code-reviewer", prompt }];
}

export const ARMS = {
  "kiln-rc40": kilnRc40,
  sources: (ctx) => [...bmadThorough(ctx), ...shipPersonas(ctx)],
};
