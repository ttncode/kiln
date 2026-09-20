# kiln

kiln takes one unit of work — a ticket reference, or just a sentence — and drives it to a
reviewed, verified, ship-ready change. While it does that, it blocks unsafe actions at runtime
instead of asking the agent nicely not to take them.

**Status: not built yet.** The design is finished and the repository currently holds only that.
See [What exists today](#what-exists-today).

## Table of Contents

- [Why this exists](#why-this-exists)
- [What exists today](#what-exists-today)
- [The shape of a run](#the-shape-of-a-run)
- [What it refuses to do](#what-it-refuses-to-do)
- [Design documents](#design-documents)
- [License](#license)

## Why this exists

Skill libraries raise the floor on what an agent *can do*. kiln is about what happens when the
agent is **wrong**.

|  | Raises the quality floor | Blocks a wrong action | State survives the session | Project memory |
|---|---|---|---|---|
| [Superpowers](https://github.com/obra/superpowers) | strongest inner loop | prompt only | — | — |
| [agent-skills](https://github.com/addyosmani/agent-skills) | broadest lifecycle | prompt only | — | — |
| [BMAD](https://github.com/bmad-code-org/bmad-method) | yes | — | spec frontmatter | — |
| **kiln** | inherits both | **hooks block at runtime** | **one state file, resumable** | **grep → DNA** |

Column three is measured, not claimed. A `PreToolUse` hook returning exit 2 blocks a real write in
Claude Code 2.1.270 — including under `bypassPermissions`, and including inside a subagent. A
harness permission prompt is bypassable; a hook guard is not.

## What exists today

1. **The design** — locked, with 85 decision entries, each carrying its rationale.
2. **The audit** — five review passes, the evidence behind every decision, and the findings each
   pass produced.
3. **The user view** — the same design described from the seat of someone using it.
4. **The verification plan** — four test tiers and the scenario matrix.
5. **No code.** Construction starts at P0, the walking skeleton.

## The shape of a run

Seven stages, and ceremony scales to the work rather than being fixed:

1. **INVESTIGATE** → `brief.md`. Ends by classifying how much ceremony this work needs, out loud,
   and you can override it.
2. **SPEC** → `spec.md`. The heaviest path only.
3. **PLAN** → `plan.md`, plus a change preview whose every row comes from the plan, never from a
   guess about what the coder will do.
4. **IMPLEMENT** → source. The approved plan's gate is what unlocks writing it.
5. **REVIEW** → `review.md`, plus one line reconciling the files the plan predicted against the
   files the diff actually touched.
6. **VERIFY** → each step's exit code, recorded. Standard output is never parsed for a verdict.
7. **SHIP** → a pull request on your branch.

Three paths decide how many of those you get: `spike` (1 gate, answers a question, cannot ship),
`bounded` (2 gates), `full` (4 gates). The ratchet only goes up.

## What it refuses to do

- **Ship clients for your tracker, forge or browser.** Your agent already has MCP and `gh`/`glab`.
- **Require a tracker.** The primary entry point is one sentence.
- **Require Docker, a database, a browser, Python, or CI.** Those are facts about your project,
  declared in one config file.
- **Improvise around a broken environment.** A missing module stops the run and prints the tool's
  own error, verbatim.
- **Require a git worktree for isolation.** Submodule layouts and fixed build paths cannot provide
  one.

## Design documents

| File | Holds |
|---|---|
| [`docs/design/2026-09-19-kiln-architecture.md`](docs/design/2026-09-19-kiln-architecture.md) | the durable state — scope, sections A–H, and all 85 decisions |
| [`docs/design/2026-09-19-design-audit.md`](docs/design/2026-09-19-design-audit.md) | five review passes, and the evidence behind each |
| [`docs/design/2026-09-20-user-view.md`](docs/design/2026-09-20-user-view.md) | the same design, from the user's chair |
| [`docs/design/2026-09-20-verification-plan.md`](docs/design/2026-09-20-verification-plan.md) | four test tiers and the scenario matrix |

Start with the architecture file. Nothing in it needs to be re-derived.

## License

MIT — see [LICENSE](LICENSE). Third-party provenance is recorded in [NOTICE](NOTICE).
