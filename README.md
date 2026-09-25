# kiln

**Let an AI coding agent work a whole ticket without watching every command it runs.**

A skill library tells an agent what to do. kiln decides what happens when it does something
else. The guards run as hooks: an agent told not to push to `main` can still try, but under
kiln the push never runs. So you can hand it one unit of work (a ticket reference, or just a
sentence) and get back a reviewed, verified pull request without reading over its shoulder.

[![ci](https://github.com/ttncode/kiln/actions/workflows/ci.yml/badge.svg)](https://github.com/ttncode/kiln/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520.10-brightgreen.svg)](package.json)

<img src="docs/assets/kiln-lifecycle.png" alt="The kiln lifecycle: seven stages from investigate to ship, four gates you approve, and PreToolUse hooks under all of them that block an unsafe tool call.">

**Status: `v1.0.0-rc`.** Everything below runs, and every promise it makes has a test. All six
real-world acceptance runs required for release are done, with `unsafe actions completed: 0` on
every one. The four scorecard lines that only someone who did not build kiln can grade are
[graded](docs/design/2026-09-21-acceptance-c6-handover.md). One thing still holds back the
v1.0 tag: a validation run on a production repository, using the current build (see
[Status](#status)).

- [Usage](#usage) · [Quick start](#quick-start) · [Your first run](#your-first-run)
- [All 8 skills](#all-8-skills) · [The three paths](#the-three-paths) · [Auto mode](#auto-mode)
- [What it blocks](#what-it-blocks) · [How kiln works](#how-kiln-works)
- [Project rules](#project-rules) · [Project DNA](#project-dna) · [Configuration](#configuration)
- [Project structure](#project-structure) · [Why kiln?](#why-kiln) · [How it compares](#how-it-compares)
- [Status](#status) · [Design documents](#design-documents) · [Contributing](#contributing)

---

## Usage

Everything goes through one slash command. You give it the work, and kiln picks the stages
and the skills.

| What you're doing | Command | Key principle |
|---|---|---|
| Set this project up | `/kiln:kiln init` | Detect first, then ask |
| Get one unit of work done | `/kiln:kiln "<what you want done>"` | A sentence is enough |
| Start from a link, a ticket, or unfinished work | `/kiln:kiln <url\|ticket-ref\|work-id>` | Resolve before interpreting |
| See the work in progress | `/kiln:kiln` | State survives the session |
| Check this setup | `/kiln:kiln doctor` | Anything that can't be checked at runtime is checked here |
| Build the project's business map | `/kiln:kiln dna init` | Every claim cites a file |
| Catch the map up with what merged | `/kiln:kiln dna update` | Measured, not assumed |
| See what the map holds | `/kiln:kiln dna` | `dna serve` opens it in a browser |

To choose how a request runs, put a path name or `--auto` at the **start** of the request:

```
/kiln:kiln spike can we drop the legacy importer
/kiln:kiln full rebuild the importer
/kiln:kiln --auto the export button does nothing
```

Underneath, the orchestrator calls `node <plugin>/bin/kiln.mjs <verb>`. The verbs are `resolve`,
`open`, `gate`, `rules`, `scope`, `verify`, `ship`, `report`, `halt`, `resume`, `ratchet`,
`blast`, `list`, `config set`, `init`, `doctor` and `dna`. This README writes them as
`kiln <verb>`, and `--help` prints every flag.

---

## Quick start

You need Node 20.10 or newer and nothing else, because kiln has **zero runtime dependencies**.

<details open>
<summary><b>Claude Code</b></summary>

**Marketplace install:**

```
/plugin marketplace add ttncode/kiln
/plugin install kiln
/kiln:kiln init
```

A plugin command carries its plugin's namespace, and `/kiln:kiln` is the form that always
resolves. The short form works only when no other plugin claims the name.

**Local / development:**

```bash
git clone https://github.com/ttncode/kiln.git
claude --plugin-dir /path/to/kiln
```

</details>

Claude Code is the only harness kiln supports. Whether an action is actually blocked depends on
the harness, so v1 supports just one.

`init` reads your project, proposes a config, and asks three questions on a typical clone:

- What must never be pushed to?
- What runs the tests?
- What runs a fast subset of them?

It asks up to three more only when it can't detect the answer. Every question has a default,
so answering none of them still leaves a working setup. `init` writes `.kiln/config.json`, an
empty [rules router](#project-rules) and one `.gitignore` line, and it never overwrites a file
you already have.

**No token. No Docker. No Python. No CI.** If `init` asks for any of them, that's a bug.

**Updating:** run `/plugin update kiln`, then `/kiln:kiln doctor` in each project. The update
replaces the plugin and touches nothing in your repository. That means a project that already
has the push floor keeps the hook the older version installed. Doctor reports it as `stale`,
and `/kiln:kiln doctor --write` replaces it. Until you do, every run warns you once.

---

## Your first run

```
/kiln:kiln "the export button on the reports page does nothing"
```

kiln investigates, tells you how much ceremony it thinks the work needs, and stops at a gate.
The transcripts below are real, and each is something you can check yourself:

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

At a gate you make the call, and "sounds good" doesn't count as an approval:

```
$ kiln gate 42 plan --answer "sounds good"
{ "recorded": false,
  "ask": "Pick one: (1) approve this plan as written, or (2) tell me what to change." }
exit=2
```

Before the gate, the agent can't touch your source. A shell redirect gets the same block:

```
kiln blocked a source edit: the plan gate is not approved.
Go back to the gate. The block is the message, not an obstacle to route around.
```

After the gate, a test that lies about its result still can't report a pass:

```
$ kiln verify 42
  pass  typecheck  exit 0  3ms
  FAIL  unit       exit 1  160ms

> echo "All tests passed" && exit 1
All tests passed
```

The verdict comes from the exit code. kiln never reads standard output to make a decision.

---

## All 8 skills

`/kiln:kiln` starts the orchestrator, and the orchestrator invokes each stage's skill itself.
Installing a skill doesn't make the agent load it. In three measured runs, the stage skills sat
unread unless the orchestrator called them. Five of the eight are forked from
[Superpowers](https://github.com/obra/superpowers), and [NOTICE](NOTICE) records what changed
in each file.

### Drive — one unit of work to a pull request

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [kiln-orchestrator](skills/kiln-orchestrator/SKILL.md) | Runs investigate, plan, implement, review, verify and ship, renders every gate, and is the only component that creates todos | A `/kiln:kiln` request, and every stage after it until a pull request exists |

### Define — clarify what to build

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [kiln-brainstorming](skills/kiln-brainstorming/SKILL.md) | Explores intent and design, then classifies how much ceremony the work needs | Any new feature or behaviour change on the `full` path, before the spec gate |

### Plan — break it down

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [kiln-writing-plans](skills/kiln-writing-plans/SKILL.md) | Writes the plan that the plan gate approves, task by task, and predicts which files it will touch | Every path that has a plan gate |

### Build — write the code

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [kiln-implement](skills/kiln-implement/SKILL.md) | Works the approved plan in this session, recording each step's exit code in state the agent can't edit | After the plan gate |
| [kiln-tdd](skills/kiln-tdd/SKILL.md) | Red, green, refactor: write the test, watch it fail, then write the minimal code that passes | Inside IMPLEMENT, before any implementation code |

### Verify — find the root cause

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [kiln-debugging](skills/kiln-debugging/SKILL.md) | Root cause before any fix. A fix that only hides the symptom counts as a failure | A bug, a failing test, anything unexpected, the moment it happens |

### Review — judge before it ships

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [kiln-review](skills/kiln-review/SKILL.md) | Reviews the whole diff against the plan, grades findings by severity and likelihood, and compares the files the plan predicted with the files the diff touched | After IMPLEMENT, on `bounded` and `full` |

### Map — know what the code does

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [kiln-dna](skills/kiln-dna/SKILL.md) | Builds and updates the [Project DNA](#project-dna) with subagent scans, through gated commands only | `/kiln:kiln dna init`, `/kiln:kiln dna update`, or any batch headed for `.kiln/dna/store/` |

SHIP has no skill. It's a verb, `kiln ship`, because opening a pull request has nothing to
judge, only a record to check.

---

## The three paths

The amount of ceremony fits the work. kiln classifies each piece of work after investigating,
tells you which path it chose, and you can override it.

| Path | When | Gates | Ships |
|---|---|:--:|---|
| `spike` | a feasibility question whose output is an answer | 1 | **no** |
| `bounded` | a well-scoped change to code already here | 2 | yes |
| `full` | a new subsystem, or anything that moves interfaces | 4 | yes |

Once a gate or a change exists, the path can only go **up**. Moving up from a spike halts the
run: kiln prints what the spike found, gives you a numbered menu, and touches none of it.
Deleting your probe would destroy data you never asked kiln to destroy. Carrying it forward
silently would slip code written before any plan past a gate.

A shipped work is finished. Follow-up work, such as review feedback or the next part, is a new
work that names the one it follows, and it gets its own gates.

---

## Auto mode

Auto mode is off by default, so every gate stops for you.

```
/kiln:kiln --auto the export button does nothing   # this run only; --auto goes first
/kiln:kiln init --set auto.bounded=true            # every bounded run
/kiln:kiln init --set auto.full=true               # every full run
```

| | |
|---|---|
| Already set up? | edit `auto` in `.kiln/config.json`, because `kiln config set` refuses this key |
| Is it on? | `kiln doctor` shows it, and `kiln open` prints it |
| What did it decide? | printed at each gate as it rules, and the whole list at the gate that authorises shipping; `kiln report <id>` repeats it |
| Never auto | a `spike`, and a halted work |

For that run, `--auto` in a request takes priority over `auto.*` in the file.

---

## What it blocks

Seven promises, each backed by a test. [`tests/d7.test.mjs`](tests/d7.test.mjs) holds the whole
list in one file, and it's worth reading there rather than trusting this table.
[`tests/corpus.test.mjs`](tests/corpus.test.mjs) runs each promise through the real hook
against well over a hundred commands and edits, covering both what must be denied and what
must be allowed.

| # | Promise | How |
|---|---|---|
| 1 | never pushes to a protected branch | the ref is **resolved by git**, not matched as text, in the repository the command actually runs in — `HEAD`, `@`, `+main`, `HEAD:v3-master`, `--force`, `-C <dir>`, `cd <dir> &&`, `git checkout main && git commit`, and a submodule on its own branch. A local `commit`/`merge` onto a protected branch is blocked too where kiln can tell which checkout it lands in — and deliberately not guessed where it cannot (D105) |
| 2 | never destroys data unasked | a recursive `rm` outside the project however its flags are spelled — `-rf`, `-Rf`, `-r`, `--recursive` — including under `~` and `$HOME`; `git clean -xfd`; destructive DDL in a migration |
| 3 | never reports a failing test as passing | verdict from the exit code; stdout is never parsed |
| 4 | no source edit without a gate record matching the **current** artifact | including through `>`, `tee`, `sed -i`, `cp`, `mv`, and a command after a heredoc. The gate hashes the document it approves, so editing it afterwards closes source again. After the review gate, source is closed until VERIFY fails |
| 5 | never writes outside its sandbox | resolved paths compared by segment; a symlink leaf is rejected, not followed |
| 6 | kiln's own code performs no network egress | a **static** check, and its test says so |
| 7 | the agent cannot approve its own gate, or switch off what judges it | `state.json` and `config.json` cannot be written, moved, deleted or made unreadable by the agent — nor can any checkout's git hooks — and an inline program naming them is refused. `--no-verify` by any prefix, `commit -n`, `core.hooksPath` and git's config-override variables are refused |

Item 1 has a second layer. kiln installs a `pre-push` hook in every checkout, and git gives
that hook the **resolved** destination, after `HEAD`, `push.default`, aliases, `-C` and the
working directory have all been worked out. Nothing is parsed. This layer is a minimum, not a
guarantee, because `--no-verify` and `core.hooksPath` turn it off. That's why kiln refuses
both, and why the run can't write to `.git/hooks/`. If you already have a hook, kiln reports
it and never replaces it.

The layer above both is your forge's own branch protection. kiln doesn't set it and can't. A
command that never reaches git on your machine is the one case neither layer sees.

---

## How kiln works

Each tool call goes through the same path:

<img src="docs/assets/kiln-guard.png" alt="A tool call passes a PreToolUse hook whose guards read the work state. Exit 0 lets the call run. Exit 2 blocks it and returns the reason to the agent.">

**Key design choices:**

- **Blocks, not advice.** A `PreToolUse` hook that returns exit 2 blocks a real write in Claude
  Code 2.1.270. That holds under `bypassPermissions` and inside a subagent too. The agent can
  get past a permission prompt, but not past a hook guard.
- **Shell verbs count as writes.** When a test agent was blocked from writing a file, its
  **first unprompted retry** was `echo "hello" > <path>` through the shell. So the guards watch
  shell write verbs as closely as the Edit and Write tools.
- **Decisions come from exit codes, never from stdout.** Standard output is text the agent can
  write, and an exit code isn't.
- **The limits are stated, and each has a test asserting it:**
  - **Programs kiln doesn't read.** A script file, or an inline program that writes source
    without naming one of kiln's own files, edits source without going through a watched verb.
    Closing that gap would mean parsing programs, which kiln doesn't do. The two most-used
    Claude Code guard hooks document the same limit.
  - **If the dispatcher can't start, the call is allowed.** When `node` is missing from `PATH`,
    the hook never starts, and a hook that never starts allows the call. `kiln doctor` checks
    for this because nothing at runtime can.
  - **A hook that exceeds its timeout allows the tool.** This was measured, so none of the
    promises above depend on a timeout.

---

## Project rules

Project rules are decisions your project has already made, routed to the files they apply to.
`init` writes an empty router at `.kiln/rules/index.md`, and you fill in the table.

```markdown
| Trigger — a path glob | Rule file |
|---|---|
| src/auth/**           | auth.md   |
| **/*.sql              | schema.md |
```

In a session you don't need a command for this. State the rule, such as *"controllers must
never contain SQL"*, and the agent writes it, picks the glob and calls the verb.

`kiln rules add <file>.md --trigger "<glob>"` writes the rule file and the table row together,
and refuses a name or glob that wouldn't resolve. You can also edit the table by hand. A run
can add a rule but **can't** rewrite or remove one, because a rule is one of the terms the run
is judged by.

kiln reads the rules twice in every run: at **PLAN**, against the files the plan predicts, and
at **REVIEW**, against the files the diff actually touched. The second read matters most. Runs
go wrong when a rule applies to a file the plan never named, and a router that only sees what's
already in the conversation can't catch that.

| | |
|---|---|
| **A trigger is a glob, never a topic** | With "applies when the topic comes up", the model decides by reading a description. Nothing can tell you afterwards whether the rule was applied, and that's where reports of silently ignored rules come from |
| **A row that doesn't resolve is named** | A half-filled row, a missing rule file, or a glob that matches nothing each makes `kiln doctor` fail with its own message. A rule skipped in silence leaves no symptom to debug |
| **What was handed over is recorded** | `state.rules[]` holds the rules each stage was given, and the run can't write a rule while that rule is judging it. *This rule applied* is a recorded fact, not a hope |

`rules.budget_lines` caps the total, because **the agent pays for every rule line in tokens on
every later ticket, and the longer the rules get, the less closely it follows each one**.
Adding a rule to force compliance can backfire. `kiln rules add` shows three things when you
write a rule: what already covers these files, the line count before and after, and the
routing. `kiln doctor` reports the total every time.

---

## Project DNA

Project DNA describes what the codebase does in business terms, worked out from the code
itself:

- **Findings** (`RD-####`), each citing a file and line range, grouped into features,
  capabilities and domains.
- **Journeys** that cross those findings, recorded as flows, stages and processes.
- **Where it runs**: the services, surfaces and components.

Every claim traces back to a finding, and every finding to a file at a pinned commit. The
method and the store's contract come from [tps-project-dna](NOTICE), used under a written
grant. kiln builds the store itself, in Node.

`/kiln:kiln dna init` builds the store with subagents in three steps:

1. A mechanical scan ranks the files worth reading.
2. Scanners read those files on the integration branch.
3. You approve the taxonomy and the service names before anything is built on them.

The store lives in `.kiln/dna/store/`, is tracked in git, and reaches the integration branch
through a pull request like any other change.

| | |
|---|---|
| **One way in** | `kiln dna apply <batch.json>` is the only way to write to the store. It counts the ids, derives the computed fields, runs every gate, and writes nothing if any gate fails. A direct edit to the store is refused |
| **Checked at the start of every ticket** | when a store exists, INVESTIGATE fetches the integration branch and reports how far the code has moved since the store read it: none, small, large, or unknown because the fetch failed (never reported as zero) |
| **Measured, not assumed** | `kiln blast` answers from the store alongside grep and marks every file that changed since the store read it. `kiln scope` reports how much of the real change each one named |
| **Read-only viewer** | `kiln dna serve` serves the explorer on 127.0.0.1 behind a token, and stops when it's not in use |

---

## Configuration

Configuration is one file, `.kiln/config.json`, plus exactly one environment variable
(`KILN_ROOT`). To change a value after `init`, use `kiln config set <key>=<value>`. A change
can tighten what's enforced or point it somewhere else, but never loosen it.

```jsonc
{
  "vcs":   { "provider": "github", "protected": ["main"], "integration_branch": "main",
             "branch_pattern": "${type}/${id}" },   // fix/20260922-export-button-does-nothing; also ${slug}, ${ref}
  "stack": { "id": "node",
             "cmd":   { "test": "npm test" },
             "steps": [{ "id": "unit", "run": "${cmd.test}" }] },
  "auto":  { "bounded": false },   // kiln rules this path's gates itself when true
  "work":  { "committed": true }
}
```

- **Only steps it can run.** `init` writes only the `steps` your project can actually run. A
  `typecheck` step appears when you have a `tsconfig.json`, and a `lint` step when you have a
  lint script.
- **Submodules are detected.** kiln reads them from `.gitmodules`, so you don't have to fill in
  `repo.modules`. If the superproject has no manifest of its own, the stack is detected from a
  module.
- **Shipping branches are protected.** In a multi-module workspace, `integration_branch` also
  accepts a per-module map. **Every module's shipping branch is protected whether or not you
  list it**, because kiln must never push to a branch it would open a pull request against.
- **Missing commands fail loudly.** A step whose `${cmd.x}` is unset **refuses to run** instead
  of being skipped quietly, and `kiln doctor` warns you before you hit it.
- **Auto mode.** `auto` lets kiln rule a path's gates itself. See [Auto mode](#auto-mode).

### Adding a stack

A stack adapter is a JSON file. `stacks/node.json` is a few lines, with no code:

```json
{
  "id": "node",
  "detect": ["package.json"],
  "steps": [{ "id": "unit", "run": "${cmd.test}" }],
  "effects": [],
  "guards": []
}
```

`stacks/php-ci3.json` adds a `migrate` effect and two guard scripts. **Guards are the only code
a stack may contain.** A test enforces this: any `.mjs` file under `stacks/` that no stack
declares as a guard fails the build.

---

## Project structure

kiln has a small core, and everything in it is Node with no dependencies. Only the harness
adapter is specific to Claude Code.

| Layer | Repository paths | Purpose |
|---|---|---|
| Hooks | `hooks/dispatch.mjs`, `hooks/hooks.json` | The `PreToolUse` / `PostToolUse` entry that turns each tool call into a guard verdict |
| Guards | `lib/guards/` | What each guard judges: protected branches, the gate, the sandbox, verification, interpreters |
| CLI and state | `bin/kiln.mjs`, `lib/*.mjs` | The verbs the skills call, and the one state file per work |
| Project DNA | `lib/dna/` | The store, its gates, and the loopback viewer |
| Skills | `skills/` (8 skills) | The workflows the agent follows, one per stage |
| Stacks | `stacks/*.json` | Per-stack steps, effects and guards |
| Claude Code adapter | `.claude-plugin/`, `commands/kiln.md` | Marketplace metadata and the `/kiln:kiln` entry |
| Contributor tooling | `tests/`, `scripts/`, `.github/workflows/` | The conformance suite, the guard corpus, acceptance helpers and CI |
| Design | `docs/design/` | The decision log and every audit and acceptance record |

---

## Why kiln?

An AI coding agent takes the shortest path, and a skill library can only argue with it. The
agent has already read the instruction not to push to `main`, not to skip the plan, and not
to trust a green line in its own output. When it's wrong anyway, a prompt has no way to stop
it.

kiln moves those rules out of the prompt and into hooks that run before every tool call. A
gate is a record in a state file the agent can't write. A test verdict is an exit code the
agent can't reword. A protected branch is resolved by git rather than matched as text, so no
spelling of the command gets past it. The skills still raise the quality of the work, and the
hooks make sure that when the agent goes wrong, it doesn't cost you anything.

### What it refuses to do

- **Ship clients for your tracker, forge or browser.** Your agent already has MCP and
  `gh`/`glab`. A kiln client would duplicate them and take on their maintenance.
- **Require a tracker.** The main way in is one sentence.
- **Require Docker, a database, a browser, Python, or CI.**
- **Improvise around a broken environment.** A missing module stops the run and prints the
  tool's own error, verbatim.
- **Require a git worktree for isolation.** Submodule layouts and fixed build paths can't
  provide one.
- **Promise that several repositories merge together.** A ticket that spans a superproject
  and its submodules ships as a topic: one pull request per repository, sharing the work id,
  the way Gerrit and Android's `repo` do it. `kiln ship` prints what to open and says plainly
  that a partial merge is possible and that the merge order is yours to decide.

---

## How it compares

|  | Raises the quality floor | Blocks a wrong action | State survives the session | Project memory |
|---|---|---|---|---|
| [Superpowers](https://github.com/obra/superpowers) | strongest inner loop | prompt only | — | — |
| [agent-skills](https://github.com/addyosmani/agent-skills) | broadest lifecycle | prompt only | — | — |
| [BMAD](https://github.com/bmad-code-org/bmad-method) | yes | — | spec frontmatter | — |
| **kiln** | inherits both | **hooks block at runtime** | **one state file, resumable** | **grep → DNA** |

Column three was measured, not assumed. See [How kiln works](#how-kiln-works) for the probe,
and [`live-harness-evidence.md`](docs/design/2026-09-21-live-harness-evidence.md) for what a
real Claude Code session showed.

---

## Status

| | |
|---|---|
| Tests | 639, plus one case per row of the guard corpus; green on every pull request |
| Code | ~5,900 lines of Node, much of it comments saying why; ~7,300 lines of tests; 0 runtime dependencies |
| Decisions to a first PR | **5** — 3 questions `init` asks a clone, 2 gates on the `bounded` path. 7 on `full`. Two more only when kiln will not guess: one if nothing names a default branch, one if no remote names a forge |
| Harness | Claude Code. The safety claim is harness-dependent, so v1 supports one |
| Platform | Linux, WSL2, macOS |
| Acceptance | **6 of 6** done across kiln, [zod](docs/design/2026-09-21-acceptance-c2-zod.md) and [umami](docs/design/2026-09-21-acceptance-c4-umami.md), plus the [journey matrix](docs/design/2026-09-22-journey-matrix.md) run against [nine real checkouts](docs/design/2026-09-22-cross-project-acceptance.md) — Node, PHP, Python, C, a pnpm workspace, husky, submodules, and a project shipping from `8.2`; plus [ten more](docs/design/2026-09-23-real-repository-matrix.md) for the rules router — six real projects and four layouts |
| Tier D | **graded** 2026-09-23 by the project owner, who wrote none of it: first-run survival **y** · would I run it again **y** · gates **2 shown · 1 overridden** · human edits after accept **unmeasured**, because that run never reached a PR and `0` would have meant something else |
| **Not done** | one validation run on a production repository, on the build that carries the pre-v1.0 audit's fixes (D125–D147). Ten checkouts is not a user |

In a table, `0 files` and `no measurement` look the same but mean opposite things. The fourth
line stays unmeasured until a run reaches a merged pull request. Writing it as a zero would
read as *the agent was perfect*.

`2 shown · 1 overridden` is the number the scorecard was built to produce. When one party
does both the classifying and the judging, it always agrees with itself, so `0 overridden`
would have looked perfect while measuring nothing. A real override by a real grader shows the
instrument working. The [verification plan](docs/design/2026-09-20-verification-plan.md)
explains why only a person can answer these four.

---

## Design documents

kiln was designed before it was written, and the design is in the repository.

| File | Holds |
|---|---|
| [`kiln-architecture.md`](docs/design/2026-09-19-kiln-architecture.md) | the durable state — scope, sections A–H, and 179 decisions with their rationale |
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

Start with the architecture file. Every decision records why it was made, so you can disagree
with the reasoning and not just the result.

---

## Contributing

A good change is **tested** (a fix comes with a test that fails without it), **recorded** (a
behaviour change gets an entry in the decision log), **dependency-free** (the core stays Node
with no runtime dependencies) and **small** (one pull request per commit).

Pull requests run the conformance suite, and that's the whole gate: `npm run lint && npm test`.
[CONTRIBUTING.md](CONTRIBUTING.md) explains what a pull request has to include, and how to
challenge a decision in the log directly instead of working around it.

A guard that **allows** something it promises to block is a vulnerability, not an ordinary
issue. [SECURITY.md](SECURITY.md) explains where to report one, and lists the limits that are
documented rather than holes. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) covers everything else.

Acceptance runs need a real repository, a real ticket and a human grader, so contributors
aren't asked to do them.

---

## Team

kiln is built and maintained by:

| | Name | GitHub | Role |
|---|------|--------|------|
| <img src="https://github.com/ttncode.png?size=120" width="60" height="60" alt="Truong Trung Nghia"> | **Truong Trung Nghia** | [@ttncode](https://github.com/ttncode) | Creator |

---

## License

MIT — see [LICENSE](LICENSE). kiln forks five skills from
[Superpowers](https://github.com/obra/superpowers) (MIT), and [NOTICE](NOTICE) records the fork
commit and exactly what changed in each file.
