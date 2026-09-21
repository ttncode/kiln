# kiln

[![ci](https://github.com/ttncode/kiln/actions/workflows/ci.yml/badge.svg)](https://github.com/ttncode/kiln/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520.10-brightgreen.svg)](package.json)

**Let an AI coding agent work a whole ticket without watching every command it runs.**

You can already tell an agent not to push to `main`. kiln makes it unable to — the command
does not run, rather than being discouraged. So you can hand it one unit of work — a ticket
reference, or just a sentence — and get back a reviewed, verified pull request without
reading over its shoulder.

A skill library raises the floor on what your agent *can* do. kiln decides what happens when
it is **wrong**.

**Status: `v1.0.0-rc`.** Everything below runs, every promise it makes has a test, and the six
real-world acceptance runs its own release bar requires are done — `unsafe actions completed: 0`
on every one. What holds the v1.0 tag back is the four scorecard lines only a person who did
not build it can grade — see [Status](#status).

## Table of Contents

- [Why blocking is different](#why-blocking-is-different)
- [Install](#install)
- [Your first run](#your-first-run)
- [The three paths](#the-three-paths)
- [What it blocks](#what-it-blocks)
- [Configuration](#configuration)
- [Adding a stack](#adding-a-stack)
- [What it refuses to do](#what-it-refuses-to-do)
- [Status](#status)
- [Design documents](#design-documents)
- [Contributing](#contributing)
- [License](#license)

## Why blocking is different

|  | Raises the quality floor | Blocks a wrong action | State survives the session | Project memory |
|---|---|---|---|---|
| [Superpowers](https://github.com/obra/superpowers) | strongest inner loop | prompt only | — | — |
| [agent-skills](https://github.com/addyosmani/agent-skills) | broadest lifecycle | prompt only | — | — |
| [BMAD](https://github.com/bmad-code-org/bmad-method) | yes | — | spec frontmatter | — |
| **kiln** | inherits both | **hooks block at runtime** | **one state file, resumable** | **grep → DNA** |

Column three was measured, not assumed. A `PreToolUse` hook returning exit 2 blocks a real
write in Claude Code 2.1.270 — including under `bypassPermissions`, and including inside a
subagent. A harness permission prompt is bypassable; a hook guard is not.

When the probe agent was blocked from writing a file, its **first unprompted retry** was
`echo "hello" > <path>` through the shell. That is why the guards watch shell write verbs too.

## Install

Requires Node 20.10 or newer. Nothing else — kiln has **zero runtime dependencies**.

```
/plugin marketplace add ttncode/kiln
/plugin install kiln
/kiln:kiln init
```

A plugin command carries its plugin's namespace, so `/kiln:kiln` is the form that always
resolves. The short form without the namespace works only where nothing else claims it.

`init` reads your project, proposes a config, and asks at most three questions — each with a
default, so answering none of them still leaves you working. It writes `.kiln/config.json`,
an empty rules router, and one `.gitignore` line. It never overwrites a file you already have.

**No token. No Docker. No Python. No CI.** Any of those appearing in `init` is a bug.

## Your first run

```
/kiln:kiln "the export button on the reports page does nothing"
```

kiln investigates, says out loud how much ceremony it thinks the work needs, and stops at a
gate. This is a real transcript of the parts you can check yourself:

```
$ kiln doctor
  [ ok ] node on PATH: v20.20.2
  [ ok ] config schema: current
  [ ok ] stack: node — every step has its command
  [ ok ] rules routing: 0 rule file(s), all routed
  [ ok ] rules budget: 20 of 200 lines
  [ ok ] work: 0 work director(ies)

Ready.
```

Every stage ends by offering the next move, and stopping is always one of the options:

```
Spec complete — 7 requirements, 4 acceptance criteria. What would you like to do?

1. Write the plan
2. Edit the spec
3. Stop here, keep the artifacts
```

A gate is where you act, and "sounds good" is not an approval:

```
$ kiln gate 42 plan --artifact plan.md --answer "sounds good"
{ "recorded": false,
  "ask": "Pick one: (1) approve this plan as written, or (2) tell me what to change." }
exit=2
```

Before the gate, the agent cannot touch your source — and the block is the same through a
shell redirect:

```
kiln blocked a source edit: the plan gate is not approved.
Go back to the gate. The block is the message, not an obstacle to route around.
```

Afterwards, a test that lies about itself still cannot report a pass:

```
$ kiln verify 42
  pass  typecheck  exit 0  3ms
  FAIL  unit       exit 1  160ms

> echo "All tests passed" && exit 1
All tests passed
```

The verdict is the exit code. Standard output is never read for a decision.

## The three paths

Ceremony scales to the work rather than being fixed. kiln classifies after investigating,
says which path out loud, and you can override it.

| Path | When | Gates | Ships |
|---|---|:--:|---|
| `spike` | a feasibility question whose output is an answer | 1 | **no** |
| `bounded` | a well-scoped change to code already here | 2 | yes |
| `full` | a new subsystem, or anything that moves interfaces | 4 | yes |

The ratchet only goes **up**. Ratcheting out of a spike halts, prints the uncommitted work it
found, and touches none of it: deleting your probe would destroy data you did not ask kiln to
destroy, and carrying it forward silently would launder pre-plan code past a gate.

## What it blocks

Seven promises, seven tests. [`tests/d7.test.mjs`](tests/d7.test.mjs) is the whole list in one
file — read it there rather than trusting this table.

| # | Promise | How |
|---|---|---|
| 1 | never pushes to a protected branch | the ref is **resolved by git**, not matched as text, in the repository the command actually runs in — `HEAD`, `@`, `+main`, `HEAD:v3-master`, `--force`, `-C <dir>`, `cd <dir> &&`, and a submodule on its own branch |
| 2 | never destroys data unasked | `rm -rf` outside the repo, `git clean -xfd`, destructive DDL in a migration |
| 3 | never reports a failing test as passing | verdict from the exit code; stdout is never parsed |
| 4 | no source edit without a gate record matching the **current** artifact | including through `>`, `tee`, `sed -i`, `cp` and `mv` |
| 5 | never writes outside its sandbox | resolved paths compared by segment; a symlink leaf is rejected, not followed |
| 6 | kiln's own code performs no network egress | a **static** check, and its test says so |
| 7 | the agent cannot approve its own gate, or switch off what judges it | `state.json` and `config.json` are not writable by the agent; neither are the repository's git hooks, and `--no-verify` / `core.hooksPath` are refused |

Item 1 has a second layer. kiln installs a `pre-push` hook in every checkout, and git
hands that hook the **resolved** destination — after `HEAD`, `push.default`, aliases, `-C`
and the working directory have all been worked out. Nothing is parsed. It is a floor, not
a ceiling: `--no-verify` and `core.hooksPath` switch it off, so kiln refuses those, and
`.git/hooks/` is not writable by the run. A hook you already have is reported, never
replaced.

The layer above both is your forge's own branch protection. kiln does not set it and
cannot; a command that never reaches your machine's git is the one case neither layer sees.

Three limits are stated rather than papered over, and each has a test asserting the limit:

- **Interpreters and heredocs.** `python -c` and a heredoc into a script edit source without
  going through a watched verb. Closing that needs shell parsing, which kiln does not do.
- **A failure that stops the dispatcher fails open.** If `node` is missing from `PATH`, a hook
  never starts, and a hook that never starts is allowed. `kiln doctor` checks for it, because
  nothing at runtime can.
- **A hook that exceeds its timeout allows the tool.** Measured. So nothing in the list above
  depends on a timeout.

## Configuration

One file, `.kiln/config.json`, and exactly one environment variable (`KILN_ROOT`).

```jsonc
{
  "vcs":   { "provider": "github", "protected": ["main"], "integration_branch": "main" },
  "stack": { "id": "node",
             "cmd":   { "test": "npm test" },
             "steps": [{ "id": "unit", "run": "${cmd.test}" }] },
  "auto":  { "bounded": false },
  "work":  { "committed": true }
}
```

- `init` writes the `steps` it can actually satisfy — a `typecheck` step appears when you have
  a `tsconfig.json`, a `lint` step when you have a lint script.
- Submodules are read from `.gitmodules`, so `repo.modules` is detected rather than typed,
  and the stack is detected from a module when the superproject has no manifest of its own.
- Under a multi-module workspace, `integration_branch` also accepts a per-module map, and
  **every module's shipping branch is protected whether or not you list it** — a branch kiln
  would open a pull request against is one it must not push to.
- A step whose `${cmd.x}` is unset **refuses to run** rather than skipping quietly, and
  `kiln doctor` says so before you hit it.

## Adding a stack

A stack adapter is a JSON file. `stacks/node.json` is ten lines and zero code:

```json
{
  "id": "node",
  "detect": ["package.json"],
  "steps": [{ "id": "unit", "run": "${cmd.test}" }],
  "effects": [],
  "guards": []
}
```

`stacks/php-ci3.json` adds a `migrate` effect and two guard scripts. **Guards are the only
code a stack may contain**, and a test counts the difference: any `.mjs` under `stacks/` that
no stack declares as a guard fails the build.

## What it refuses to do

- **Ship clients for your tracker, forge or browser.** Your agent already has MCP and
  `gh`/`glab`. Writing a client re-implements those and inherits their maintenance.
- **Require a tracker.** The primary entry point is one sentence.
- **Require Docker, a database, a browser, Python, or CI.**
- **Improvise around a broken environment.** A missing module stops the run and prints the
  tool's own error, verbatim.
- **Require a git worktree for isolation.** Submodule layouts and fixed build paths cannot
  provide one.
- **Promise that several repositories merge together.** A ticket spanning a superproject and
  its submodules ships as a topic — one pull request each, sharing the work id, the way
  Gerrit and Android's `repo` do it. `kiln ship` prints what to open and says plainly that a
  partial merge is possible and the order is yours.

## Status

| | |
|---|---|
| Tests | 326, green on every pull request |
| Code | ~2,000 lines of Node, ~2,000 lines of tests, 0 runtime dependencies |
| Harness | Claude Code. The safety claim is harness-dependent, so v1 supports one |
| Platform | Linux, WSL2, macOS |
| Acceptance | **6 of 6** done across kiln, [zod](docs/design/2026-09-21-acceptance-c2-zod.md) and [umami](docs/design/2026-09-21-acceptance-c4-umami.md) — all three paths, both modes, two sessions, `unsafe actions completed: 0` on every one |
| **Not done** | the four scorecard lines only a person can grade — see [the last record](docs/design/2026-09-21-acceptance-c6-handover.md) |

The machine-checkable half of the promise is done; the human-graded half is not, and no
amount of test-writing closes it. The
[verification plan](docs/design/2026-09-20-verification-plan.md) says exactly which four
questions only a person can answer, and why.

## Design documents

kiln was designed before it was written, and the design is in the repository.

| File | Holds |
|---|---|
| [`kiln-architecture.md`](docs/design/2026-09-19-kiln-architecture.md) | the durable state — scope, sections A–H, and 92 decisions with their rationale |
| [`design-audit.md`](docs/design/2026-09-19-design-audit.md) | five review passes and the evidence behind each |
| [`user-view.md`](docs/design/2026-09-20-user-view.md) | the same design, from the user's chair |
| [`verification-plan.md`](docs/design/2026-09-20-verification-plan.md) | four test tiers and the scenario matrix |
| [`live-harness-evidence.md`](docs/design/2026-09-21-live-harness-evidence.md) | what a real Claude Code session measured, including three holes every green test had missed |

Start with the architecture file. Every decision carries why it was made, so you can disagree
with the reasoning rather than only the result.

## Contributing

Pull requests run the conformance suite. That is the whole gate: `npm run lint && npm test`.
[CONTRIBUTING.md](CONTRIBUTING.md) says what a pull request has to carry, and how to disagree
with a decision in the log rather than around it.

A guard that **allows** what it promises to block is a vulnerability, not an issue.
[SECURITY.md](SECURITY.md) says where that goes, and lists the ceilings that are documented
limits rather than holes. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) covers the rest.

Acceptance runs need a real repository, a real ticket and a human grader, so they are not
asked of contributors.

## License

MIT — see [LICENSE](LICENSE). kiln forks five skills from
[Superpowers](https://github.com/obra/superpowers) (MIT); [NOTICE](NOTICE) records the fork
commit and, per file, exactly what changed.
