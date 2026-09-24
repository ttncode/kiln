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
on every one. The four scorecard lines only a person who did not build it can grade are
[graded](docs/design/2026-09-21-acceptance-c6-handover.md). What holds the v1.0 tag back is one
validation run on a production repository, on the current build — see [Status](#status).

## Table of Contents

- [Why blocking is different](#why-blocking-is-different)
- [Install](#install)
- [Usage](#usage)
- [Your first run](#your-first-run)
- [The three paths](#the-three-paths)
- [Auto mode](#auto-mode)
- [What it blocks](#what-it-blocks)
- [Project rules](#project-rules)
- [Project DNA](#project-dna)
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

`init` reads your project, proposes a config, and asks three questions on a typical clone —
what must never be pushed to, what runs the tests, what runs a fast subset of them — plus up
to three more only where it cannot detect the answer. Each has a default, so answering none
of them still leaves you working. It writes `.kiln/config.json`,
an empty [rules router](#project-rules), and one `.gitignore` line. It never overwrites a file you already have.

**No token. No Docker. No Python. No CI.** Any of those appearing in `init` is a bug.

**Updating:** `/plugin update kiln`, then `/kiln:kiln doctor` in each project. The update replaces
the plugin and touches nothing in your repository — which also means a project that already
has the push floor keeps the hook the older version installed. Doctor reports that as `stale`
and `/kiln:kiln doctor --write` replaces it; every run warns once until it is done.

## Usage

```
/kiln:kiln init                      set this project up
/kiln:kiln "<what you want done>"    one unit of work, to a reviewed pull request
/kiln:kiln <url|ticket-ref|work-id>  the same, from a link, a ticket, or work in progress
/kiln:kiln                           list work in progress
/kiln:kiln doctor                    check this setup
/kiln:kiln dna init                  build the project's business map from its code
/kiln:kiln dna update                catch the map up with what merged since
/kiln:kiln dna                       what the map holds; `dna serve` opens it in a browser
```

Say a path or `--auto` at the **start** of the request to choose how it runs:

```
/kiln:kiln spike can we drop the legacy importer
/kiln:kiln full rebuild the importer
/kiln:kiln --auto the export button does nothing
```

Underneath, the orchestrator calls `node <plugin>/bin/kiln.mjs <verb>` — `resolve`, `open`,
`gate`, `rules`, `scope`, `verify`, `ship`, `report`, `halt`, `resume`, `ratchet`, `blast`,
`list`, `config set`, `init`, `doctor`, `dna`. This README writes that as `kiln <verb>`; `--help`
prints the list with every flag.

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
$ kiln gate 42 plan --answer "sounds good"
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

The ratchet only goes **up** once a gate or a change exists. Ratcheting out of a spike halts,
prints what it found with a numbered menu, and touches none of it: deleting your probe would
destroy data you did not ask kiln to destroy, and carrying it forward silently would launder
pre-plan code past a gate.

A shipped work is finished. Follow-up work — review feedback, the next part — is a new work
that names the one it follows, and gets its own gates.

## Auto mode

Off by default — every gate stops for you.

```
/kiln:kiln --auto the export button does nothing   # this run only; --auto goes first
/kiln:kiln init --set auto.bounded=true            # every bounded run
/kiln:kiln init --set auto.full=true               # every full run
```

| | |
|---|---|
| Already set up? | edit `auto` in `.kiln/config.json` — `kiln config set` refuses this key |
| Is it on? | `kiln doctor`, and `kiln open` prints it |
| What did it decide? | printed at each gate as it rules, and the whole list at the gate that authorises shipping; `kiln report <id>` repeats it |
| Never auto | a `spike`, and a halted work |

`--auto` in a request wins over `auto.*` in the file, for that run.

## What it blocks

Seven promises, seven tests. [`tests/d7.test.mjs`](tests/d7.test.mjs) is the whole list in one
file — read it there rather than trusting this table — and
[`tests/corpus.test.mjs`](tests/corpus.test.mjs) runs each promise against well over a hundred
commands and edits, the must-deny and the must-allow, through the real hook.

| # | Promise | How |
|---|---|---|
| 1 | never pushes to a protected branch | the ref is **resolved by git**, not matched as text, in the repository the command actually runs in — `HEAD`, `@`, `+main`, `HEAD:v3-master`, `--force`, `-C <dir>`, `cd <dir> &&`, `git checkout main && git commit`, and a submodule on its own branch. A local `commit`/`merge` onto a protected branch is blocked too where kiln can tell which checkout it lands in — and deliberately not guessed where it cannot (D105) |
| 2 | never destroys data unasked | a recursive `rm` outside the project however its flags are spelled — `-rf`, `-Rf`, `-r`, `--recursive` — including under `~` and `$HOME`; `git clean -xfd`; destructive DDL in a migration |
| 3 | never reports a failing test as passing | verdict from the exit code; stdout is never parsed |
| 4 | no source edit without a gate record matching the **current** artifact | including through `>`, `tee`, `sed -i`, `cp`, `mv`, and a command after a heredoc. The gate hashes the document it approves, so editing it afterwards closes source again. After the review gate, source is closed until VERIFY fails |
| 5 | never writes outside its sandbox | resolved paths compared by segment; a symlink leaf is rejected, not followed |
| 6 | kiln's own code performs no network egress | a **static** check, and its test says so |
| 7 | the agent cannot approve its own gate, or switch off what judges it | `state.json` and `config.json` cannot be written, moved, deleted or made unreadable by the agent — nor can any checkout's git hooks — and an inline program naming them is refused. `--no-verify` by any prefix, `commit -n`, `core.hooksPath` and git's config-override variables are refused |

Item 1 has a second layer. kiln installs a `pre-push` hook in every checkout, and git
hands that hook the **resolved** destination — after `HEAD`, `push.default`, aliases, `-C`
and the working directory have all been worked out. Nothing is parsed. It is a floor, not
a ceiling: `--no-verify` and `core.hooksPath` switch it off, so kiln refuses those, and
`.git/hooks/` is not writable by the run. A hook you already have is reported, never
replaced.

The layer above both is your forge's own branch protection. kiln does not set it and
cannot; a command that never reaches your machine's git is the one case neither layer sees.

Three limits are stated rather than papered over, and each has a test asserting the limit:

- **Programs kiln does not read.** A script file, or an inline program that writes source
  without naming one of kiln's own files, edits source without going through a watched verb.
  Closing that needs program parsing, which kiln does not do — the two most-used Claude Code
  guard hooks record the same limit.
- **A failure that stops the dispatcher fails open.** If `node` is missing from `PATH`, a hook
  never starts, and a hook that never starts is allowed. `kiln doctor` checks for it, because
  nothing at runtime can.
- **A hook that exceeds its timeout allows the tool.** Measured. So nothing in the list above
  depends on a timeout.

## Project rules

Things this project has already decided, routed to the files they are about. `init` writes
an empty router at `.kiln/rules/index.md`; you fill in the table.

```markdown
| Trigger — a path glob | Rule file |
|---|---|
| src/auth/**           | auth.md   |
| **/*.sql              | schema.md |
```

In a session you do not type a command for this: say what the rule is — *"controllers must
never contain SQL"* — and the agent writes it, picks the glob, and calls the verb.

`kiln rules add <file>.md --trigger "<glob>"` writes the file and the row together and
refuses a name or a glob that would not resolve; editing the table by hand works too. A run
may call it and **cannot** rewrite or remove a rule — a rule is one of the terms the run is
judged by.

kiln reads it twice in every run — at **PLAN** against the files the plan predicts, and at
**REVIEW** against the files the diff actually touched. The second one is the point: a rule
reaching a file the plan never named is exactly where a run goes wrong, and a router that
only sees what is already in the conversation cannot get there.

Three properties, each chosen against a way this fails elsewhere:

| | |
|---|---|
| **A trigger is a glob, never a topic** | "Applies when the topic comes up" is matched by the model reading a description. Nothing can tell you afterwards whether it was applied, and it is where the reports of silently-ignored rules come from |
| **A row that does not resolve is named** | A half-filled row, a rule file that is not there, a glob matching nothing in the project — `kiln doctor` fails on each, by its own text. A rule skipped in silence has no symptom to debug |
| **What was handed over is recorded** | `state.rules[]` holds the rules each stage was given, and the run may not write a rule while it is being judged by one. *This rule applied* is a fact, not a hope |

`rules.budget_lines` caps the total, because **every rule line is a token the agent pays on
every later ticket, and the longer the rules get the lower its compliance with each one** —
adding a rule to force compliance can backfire. `kiln rules add` asks the three questions
where you write the rule: what already covers these files, the line count before and after,
and the routing. `kiln doctor` reports the total every time.

## Project DNA

What the codebase does, in business terms, reverse-engineered from the code: findings
(`RD-####`, each citing file and lines) grouped into features, capabilities and domains; the
journeys that cross them as flows, stages and processes; the services, surfaces and components
they run on. Every claim walks back to a finding and every finding to a file at a pinned
commit. The method and the store's contract are
[tps-project-dna](NOTICE)'s, used under a written grant; kiln builds the store itself, in Node.

`/kiln:kiln dna init` builds it with subagents: a mechanical scan ranks the files worth reading,
scanners read them at the integration branch, and you approve the taxonomy and the service
names before anything is built on them. The store lives in `.kiln/dna/store/`, is tracked, and
reaches the integration branch through a pull request like any other change.

| | |
|---|---|
| **One door** | `kiln dna apply <batch.json>` is the only write. It counts the ids, derives what the store computes, runs every gate, and writes nothing if one fails; an edit into the store is refused |
| **Asked at the start of a ticket** | when a store exists, INVESTIGATE fetches the integration branch and says how far the code has moved from what the store read — none, small, large, or unknown because the fetch failed, never zero |
| **Measured, not assumed** | `kiln blast` answers from the store beside the grep, marks every file changed since the store read it, and `kiln scope` reports how much of the real change each one named |
| **Read-only viewer** | `kiln dna serve` serves the explorer on 127.0.0.1, behind a token, and stops when unused |

## Configuration

One file, `.kiln/config.json`, and exactly one environment variable (`KILN_ROOT`).
`kiln config set <key>=<value>` changes a value after `init` — a change may tighten what is
enforced or re-aim it, never loosen it.

```jsonc
{
  "vcs":   { "provider": "github", "protected": ["main"], "integration_branch": "main",
             "branch_pattern": "${type}/${id}" },   // fix/20260922-export-button-does-nothing
  "stack": { "id": "node",
             "cmd":   { "test": "npm test" },
             "steps": [{ "id": "unit", "run": "${cmd.test}" }] },
  "auto":  { "bounded": false },   // kiln rules this path's gates itself when true
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
- `auto` lets kiln rule a path's gates itself — see [Auto mode](#auto-mode).

## Adding a stack

A stack adapter is a JSON file. `stacks/node.json` is a few lines and zero code:

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
| Tests | 619, plus one case per row of the guard corpus; green on every pull request |
| Code | ~5,900 lines of Node, much of it comments saying why; ~7,300 lines of tests; 0 runtime dependencies |
| Decisions to a first PR | **5** — 3 questions `init` asks a clone, 2 gates on the `bounded` path. 7 on `full`. Two more only when kiln will not guess: one if nothing names a default branch, one if no remote names a forge |
| Harness | Claude Code. The safety claim is harness-dependent, so v1 supports one |
| Platform | Linux, WSL2, macOS |
| Acceptance | **6 of 6** done across kiln, [zod](docs/design/2026-09-21-acceptance-c2-zod.md) and [umami](docs/design/2026-09-21-acceptance-c4-umami.md), plus the [journey matrix](docs/design/2026-09-22-journey-matrix.md) run against [nine real checkouts](docs/design/2026-09-22-cross-project-acceptance.md) — Node, PHP, Python, C, a pnpm workspace, husky, submodules, and a project shipping from `8.2`; plus [ten more](docs/design/2026-09-23-real-repository-matrix.md) for the rules router — six real projects and four layouts |
| Tier D | **graded** 2026-09-23 by the project owner, who wrote none of it: first-run survival **y** · would I run it again **y** · gates **2 shown · 1 overridden** · human edits after accept **unmeasured**, because that run never reached a PR and `0` would have meant something else |
| **Not done** | one validation run on a production repository, on the build that carries the pre-v1.0 audit's fixes (D125–D147). Ten checkouts is not a user |

`0 files` and `no measurement` render identically in a table and mean opposite things. The
fourth line stays unmeasured until a run reaches a merged pull request, rather than being
written as a zero that would read as *the agent was perfect*.

`2 shown · 1 overridden` is the number the scorecard was built to produce. One party doing
both the classifying and the judging always agrees with itself, so `0 overridden` would have
read as perfect while measuring nothing. A real override by a real grader is the instrument
working. The
[verification plan](docs/design/2026-09-20-verification-plan.md) says why only a person can
answer these four.

## Design documents

kiln was designed before it was written, and the design is in the repository.

| File | Holds |
|---|---|
| [`kiln-architecture.md`](docs/design/2026-09-19-kiln-architecture.md) | the durable state — scope, sections A–H, and 165 decisions with their rationale |
| [`design-audit.md`](docs/design/2026-09-19-design-audit.md) | five review passes and the evidence behind each |
| [`user-view.md`](docs/design/2026-09-20-user-view.md) | the same design, from the user's chair |
| [`verification-plan.md`](docs/design/2026-09-20-verification-plan.md) | four test tiers and the scenario matrix |
| [`live-harness-evidence.md`](docs/design/2026-09-21-live-harness-evidence.md) | what a real Claude Code session measured, including three holes every green test had missed |
| [`journey-matrix.md`](docs/design/2026-09-22-journey-matrix.md) | kiln as a user meets it — 56 rows, and the ten where two separate fixes could disagree |
| [`cross-project-acceptance.md`](docs/design/2026-09-22-cross-project-acceptance.md) | the same matrix against nine checkouts nobody here designed |
| [`real-repository-matrix.md`](docs/design/2026-09-23-real-repository-matrix.md) | the rules router across ten checkouts — six real projects and four layouts — and the two defects that found |
| [`upstream-read.md`](docs/design/2026-09-23-upstream-read.md) | the release-checklist step the fork costs: what upstream did since the fork point, and the bug of theirs kiln was still carrying |
| [`acceptance-c7-rc33.md`](docs/design/2026-09-23-acceptance-c7-rc33.md) | the audit's build driven through real Claude Code sessions — interactive, auto, and twelve forbidden actions — and the nine defects that found |
| [`pre-v1-audit.md`](docs/design/2026-09-23-pre-v1-audit.md) | the audit the design owes itself before a v1.0 tag — the read-back, and the second pass that ran a 142-row corpus through the real hook and weighed every finding against mature open-source projects |

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
