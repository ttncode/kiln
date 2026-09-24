# AGENTS.md

kiln is a Claude Code plugin: `PreToolUse` hooks that block unsafe agent actions, an orchestrator
skill that drives one unit of work to a reviewed pull request, and Project DNA (a business map of
the codebase). Node 20.10+, zero runtime dependencies.

## Commands

- `npm run check` — lint then the full suite; CI runs exactly this, plus the shellcheck line in
  `.github/workflows/ci.yml`.
- `node --test tests/<file>.test.mjs` — one test file.
- `node bin/kiln.mjs <verb>` — the CLI the skills call (`--help` lists every verb).

## Where things live

- `hooks/dispatch.mjs` — the hook entry; `lib/guards/` — what each guard judges.
- `bin/kiln.mjs`, `lib/*.mjs` — the CLI and its state; `lib/dna/` — the DNA store and commands.
- `skills/` — the skills the agent follows; `stacks/*.json` — per-stack steps, guards, surface rules.
- `docs/design/2026-09-19-kiln-architecture.md` — the decision log (`D###`), the durable state.
- `tests/corpus.test.mjs` — must-deny / must-allow commands run through the real hook.

## How to decide

For any bug or decision, in this order:

1. **Identify the problem.** Reproduce it; name the root cause, not the symptom.
2. **Consult proven open source** — codebases, commits and issues of projects that are in real
   use (e.g. superpowers, BMAD, agent-skills, cc-safety-net, destructive_command_guard).
3. **Evaluate and choose what fits this product.** The open-source approach is the first
   candidate, not an obligation; say why when you depart from it.

Avoid:

- Inventing a new solution that has not been proven and put into use somewhere.
- Rewriting something open source already provides.

## Hard rules

- IMPORTANT: every behaviour change gets a decision entry in the architecture log, with the
  reason and what was measured. Doc counts ("N decisions", the README test count) follow.
- YOU MUST keep the core Node-only with no runtime dependencies, and no network egress beyond
  `git fetch` / `git ls-remote` and the one loopback listener (`lib/dna/serve.mjs`).
- Never route around a kiln guard block, and never offer a step the guard refuses.
- Vendored files stay unchanged (`skills/kiln-brainstorming/scripts/`, `vendor/`, the
  tps-project-dna pages in `skills/kiln-dna/`); what was copied is recorded in `NOTICE`.
- Lint is strict (functions ≤ 20 lines, ≤ 2 params, complexity ≤ 10): split, don't disable.
- A fix comes with a test that fails without it; a guard change adds corpus rows.
- Land one pull request per commit, squash-merged in order after CI passes.

## Philosophy

- Quality over speed.
- Think before every action.
- Earn trust through consistency.

## Token Efficiency
- Never re-read files you just wrote or edited. You know the contents.
- Never re-run commands to "verify" unless the outcome was uncertain.
- Don't echo back large blocks of code or file contents unless asked.
- Batch related edits into single operations. Don't make 5 edits when 1 handles it.
- Skip confirmations like "I'll continue..." Just do it.
- If a task needs 1 tool call, don't use 3. Plan before acting.
- Do not summarize what you just did unless the result is ambiguous or you need additional input.
