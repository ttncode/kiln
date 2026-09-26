# kiln

**Let an AI coding agent work a whole ticket without watching every command it runs.**

A skill library tells an agent what to do. kiln's guards are hooks that stop it from doing
anything else. Give it a ticket or one sentence, and you get back a reviewed, verified pull
request.

[![ci](https://github.com/ttncode/kiln/actions/workflows/ci.yml/badge.svg)](https://github.com/ttncode/kiln/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520.10-brightgreen.svg)](package.json)

<img src="docs/assets/kiln-lifecycle.png" alt="The kiln lifecycle: seven stages from investigate to ship, four gates you approve, and PreToolUse hooks under all of them that block an unsafe tool call.">

**Status: `v1.0.0-rc`.** Every promise has a test, and all six acceptance runs are done. The
v1.0 tag is waiting on one validation run on a production repository (see [Status](#status)).

[Usage](#usage) · [Quick start](#quick-start) · [Your first run](#your-first-run) ·
[Skills](#all-8-skills) · [Paths](#the-three-paths) · [Auto mode](#auto-mode) ·
[What it blocks](#what-it-blocks) · [How it works](#how-kiln-works) · [Status](#status)

---

## Usage

| What you're doing | Command | Key principle |
|---|---|---|
| Set this project up | `/kiln:kiln init` | Detect first, then ask |
| Get one unit of work done | `/kiln:kiln "<what you want done>"` | A sentence is enough |
| Start from a link, a ticket, or unfinished work | `/kiln:kiln <url\|ticket-ref\|work-id>` | Resolve before interpreting |
| See the work in progress | `/kiln:kiln` | State survives the session |
| Check this setup | `/kiln:kiln doctor` | Checks what can't be checked at runtime |
| Build or update the business map | `/kiln:kiln dna init` · `dna update` | Every claim cites a file |

Put a path name or `--auto` at the start of a request to choose how it runs:

```
/kiln:kiln spike can we drop the legacy importer
/kiln:kiln --auto the export button does nothing
```

Underneath, the skills call `kiln <verb>` (`node bin/kiln.mjs`); `--help` lists every verb.

---

## Quick start

You need Node 20.10 or newer. kiln has **zero runtime dependencies**.

<details open>
<summary><b>Claude Code</b></summary>

```
/plugin marketplace add ttncode/kiln
/plugin install kiln
/kiln:kiln init
```
</details>

**No token. No Docker. No Python. No CI.**

To update, run `/plugin update kiln`, then `/kiln:kiln doctor` in each project.

---

## Your first run

A sentence:

```
/kiln:kiln "the export button on the reports page does nothing"
```

JIRA Ticket ID:

```
/kiln:kiln UN-325
```

GitLab URL:

```
/kiln:kiln https://gitlab/project/-/work_items/1957
```

---

## All 8 skills

The orchestrator calls each stage's skill itself. Five are forked from
[Superpowers](https://github.com/obra/superpowers), and [NOTICE](NOTICE) records what changed.

| Stage | Skill | What It Does |
|---|---|---|
| Drive | [kiln-orchestrator](skills/kiln-orchestrator/SKILL.md) | Runs every stage from investigate to ship and renders every gate |
| Define | [kiln-brainstorming](skills/kiln-brainstorming/SKILL.md) | Explores the design and classifies how much ceremony the work needs |
| Plan | [kiln-writing-plans](skills/kiln-writing-plans/SKILL.md) | Writes the plan the plan gate approves |
| Build | [kiln-implement](skills/kiln-implement/SKILL.md) | Works the plan task by task, recording each exit code |
| Build | [kiln-tdd](skills/kiln-tdd/SKILL.md) | Test first, watch it fail, then the minimal code to pass |
| Verify | [kiln-debugging](skills/kiln-debugging/SKILL.md) | Root cause before any fix |
| Review | [kiln-review](skills/kiln-review/SKILL.md) | Reviews the diff against the plan and grades each finding |
| Map | [kiln-dna](skills/kiln-dna/SKILL.md) | Builds and updates the [Project DNA](#project-dna) |

---

## Practices at every stage

Each stage also reads practices taken from [agent-skills](https://github.com/addyosmani/agent-skills),
[Superpowers](https://github.com/obra/superpowers) and [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD),
copied as their authors wrote them and changed only where kiln works differently —
every copy and edit is in [skills/copies.json](skills/copies.json). They are not skills of
their own: `kiln practices <id> --stage <stage>` decides in code which apply to the work, and
the review gate checks the review's readers were run.

### Define

| Practice | What It Does | Read When |
|---|---|---|
| [interview-me](skills/kiln-orchestrator/interview-me.md) (agent-skills) | One question at a time, each with a guess, until the intent is confirmed with an explicit yes | `full`, or the request cannot say who, why, success and constraint |
| [idea-refine](skills/kiln-brainstorming/idea-refine.md) (agent-skills) | Divergent then convergent thinking to turn a vague idea into a concrete one | `spike` |
| [spec-driven-development](skills/kiln-brainstorming/spec-driven-development.md) (agent-skills, excerpt) | Assumptions first, six core areas, Always / Ask first / Never boundaries, success criteria | `full` |
| spec kernel and architecture adversary (BMAD) | Explicit non-goals, a testable success signal, a claim-by-claim preservation pass, domain gaps as open questions | `full`, in the spec review |

### Plan

| Practice | What It Does | Read When |
|---|---|---|
| [planning-and-task-breakdown](skills/kiln-writing-plans/planning-and-task-breakdown.md) (agent-skills) | Vertical slices, dependency order, task sizing, checkpoints | always |
| I/O & edge-case matrix (BMAD) | One row per input the change must handle, each pinned by a test and audited at handover | `bounded`, `full` |
| [api-and-interface-design](skills/kiln-writing-plans/api-and-interface-design.md) (agent-skills) | Contract first, Hyrum's Law, error semantics, boundary validation | the plan flags a public API, or the change reaches an API surface |
| [deprecation-and-migration](skills/kiln-writing-plans/deprecation-and-migration.md) (agent-skills) | Expand/contract schema changes, tested down-migrations, strangler and adapter patterns | migrations, SQL, or entity changes |
| [documentation-and-adrs](skills/kiln-writing-plans/documentation-and-adrs.md) (agent-skills) | Decision records for what is expensive to reverse | `full`, or a public API change |
| [observability-and-instrumentation](skills/kiln-writing-plans/observability-and-instrumentation.md) (agent-skills) | Structured logs, RED metrics, tracing, symptom-based alerts | an endpoint or a batch job |
| [security-and-hardening](skills/kiln-review/security-and-hardening.md) (agent-skills) | Threat model first: trust boundaries, assets, abuse cases | the plan flags security, or auth, session, payment, token or upload files |
| [frontend-ui-engineering](skills/kiln-writing-plans/frontend-ui-engineering.md) + [accessibility checklist](skills/kiln-writing-plans/accessibility-checklist.md) (agent-skills) | Component architecture, state, WCAG 2.1 AA | UI files, or a screen |

### Build

| Practice | What It Does | Read When |
|---|---|---|
| [incremental-implementation](skills/kiln-implement/incremental-implementation.md) (agent-skills) | Thin slices, one thing at a time, safe defaults, rollback-friendly steps | always |
| [test-driven-development](skills/kiln-tdd/test-driven-development.md) (agent-skills) | Test sizes, the pyramid, Prove-It; Superpowers' Iron Law governs | always |
| [source-driven-development](skills/kiln-implement/source-driven-development.md) (agent-skills) | Framework code grounded in the official docs for the version in use | third-party imports, dependency files, `spike` |
| [doubt-driven-development](skills/kiln-implement/doubt-driven-development.md) (agent-skills) | A fresh-context reviewer for each non-trivial decision, in flight | security or migration flags, destructive operations |
| [ci-cd-and-automation](skills/kiln-implement/ci-cd-and-automation.md) (agent-skills) | Quality gates in the pipeline, fast feedback | CI or deploy files |
| [browser-testing-with-devtools](skills/kiln-implement/browser-testing-with-devtools.md) (agent-skills) | Live DOM, console, network and performance checks | UI files, with the DevTools MCP server |
| [code-simplification](skills/kiln-implement/code-simplification.md), [verification-before-completion](skills/kiln-implement/verification-before-completion.md), [definition-of-done](skills/kiln-implement/definition-of-done.md) | Simplify the diff, prove every claim, meet the standing bar | at every handover to REVIEW |
| [root-cause-tracing and three more](skills/kiln-debugging/SKILL.md) (Superpowers), [debugging-and-error-recovery](skills/kiln-debugging/debugging-and-error-recovery.md), [dispatching-parallel-agents](skills/kiln-debugging/dispatching-parallel-agents.md) | Trace backward, defend in depth, bisect a polluting test, one agent per independent failure | any failure |

### Review — readers launched in parallel

| Reader | What It Does | Runs |
|---|---|---|
| reviewer (Superpowers + agent-skills' [five axes](skills/kiln-review/code-review-and-quality.md)) | Plan alignment, correctness, readability, architecture, security, performance | always |
| [blind hunter](skills/kiln-review/lenses/blind-hunter.md) (BMAD) | Reads only the diff, and looks for what is missing | always |
| [edge-case hunter](skills/kiln-review/lenses/edge-case-hunter.md) (BMAD) | Walks every branch; checks what deleted code carried; tries to falsify the author's claims | always |
| [verification gap](skills/kiln-review/lenses/verification-gap.md) (BMAD) | Would the tests fail if this broke where it is used? | always |
| [intent alignment](skills/kiln-review/lenses/intent-alignment.md) (BMAD) | Which reading of the request the diff implements | always |
| [code-reviewer](skills/kiln-review/personas/code-reviewer.md), [security-auditor](skills/kiln-review/personas/security-auditor.md), [test-engineer](skills/kiln-review/personas/test-engineer.md) (agent-skills) | `/ship`'s three specialists | unless the change is two files or fewer, under 50 lines, and touches nothing sensitive |
| [performance](skills/kiln-review/performance-optimization.md) (agent-skills) | Measure-first performance review | the plan flags performance, or the diff reads in a loop or without a limit |

Every finding is checked at its line and graded by kiln on severity and likelihood; one fix
pass follows, each fix proved by a test that failed first.

### Ship

| Practice | What It Does | Read When |
|---|---|---|
| [git-workflow-and-versioning](skills/kiln-orchestrator/git-workflow-and-versioning.md) (agent-skills, excerpt) | Descriptive messages, the change summary, pre-commit hygiene | always |
| [shipping-and-launch](skills/kiln-orchestrator/shipping-and-launch.md) (agent-skills) | Pre-launch checklist and the rollback plan in the pull request, with a GO / NO-GO | always |

---

## The three paths

kiln picks a path after investigating, and you can override it. A path only moves up.

| Path | When | Gates | Ships |
|---|---|:--:|---|
| `spike` | a question whose output is an answer | 1 | **no** |
| `bounded` | a well-scoped change to existing code | 2 | yes |
| `full` | a new subsystem, or anything that moves interfaces | 4 | yes |

---

## Auto mode

Off by default: every gate stops for you.

```
/kiln:kiln --auto the export button does nothing   # this run only
/kiln:kiln init --set auto.bounded=true            # every bounded run
```

- `kiln config set` refuses this key; after setup, edit `auto` in `.kiln/config.json`.
- `kiln report <id>` lists what auto mode decided.
- A `spike` and a halted work are never auto.

---

## What it blocks

Seven promises, each tested in [`tests/d7.test.mjs`](tests/d7.test.mjs) and run against
more than a hundred commands in [`tests/corpus.test.mjs`](tests/corpus.test.mjs).

| # | Promise |
|---|---|
| 1 | Never pushes to a protected branch. Git resolves the ref, and a `pre-push` hook backs it up |
| 2 | Never destroys data you didn't ask to destroy: recursive `rm` outside the project, `git clean -xfd`, destructive DDL |
| 3 | Never reports a failing test as passing: the verdict is the exit code |
| 4 | No source edit without an approved gate for the current plan, through any tool or shell verb |
| 5 | Never writes outside its sandbox |
| 6 | kiln's own code performs no network egress (a static check) |
| 7 | The agent can't approve its own gate or switch off what judges it |

---

## How kiln works

<img src="docs/assets/kiln-guard.png" alt="A tool call passes a PreToolUse hook whose guards read the work state. Exit 0 lets the call run. Exit 2 blocks it and returns the reason to the agent.">

- **Blocks, not advice.** A `PreToolUse` hook that exits 2 stops the call, even under
  `bypassPermissions` and inside a subagent.
- **Shell verbs count as writes.** A blocked agent's first retry was `echo > <path>`, so the
  guards watch the shell too.
- **Exit codes, never stdout.** The agent can write text, but it can't change an exit code.

The known limits are listed in [SECURITY.md](SECURITY.md).

---

## Project rules

Rules your project has already decided, routed by path glob in `.kiln/rules/index.md`:

```markdown
| Trigger — a path glob | Rule file |
|---|---|
| src/auth/**           | auth.md   |
```

kiln checks them at PLAN against the predicted files, and at REVIEW against the files the
diff actually touched. A run can add a rule but can't change one.

## Project DNA

Project DNA is a business map of the codebase: features, flows and services, where every
claim cites a file at a pinned commit. `/kiln:kiln dna init` builds it with subagents into
`.kiln/dna/store/`, and each ticket starts by checking how far the code has moved since.

## Configuration

Everything lives in one file, `.kiln/config.json`. `kiln config set` can tighten a setting,
never loosen it.

```jsonc
{
  "vcs":   { "provider": "github", "protected": ["main"], "integration_branch": "main" },
  "stack": { "id": "node", "cmd": { "test": "npm test" },
             "steps": [{ "id": "unit", "run": "${cmd.test}" }] },
  "auto":  { "bounded": false }
}
```

A new stack is one JSON file in `stacks/`.

---

## Project structure

| Layer | Paths | Purpose |
|---|---|---|
| Hooks and guards | `hooks/`, `lib/guards/` | Turn each tool call into a verdict |
| CLI and state | `bin/kiln.mjs`, `lib/` | The verbs the skills call, and one state file per work |
| Skills | `skills/` | One workflow per stage |
| Stacks | `stacks/*.json` | Per-stack steps and guards |
| Design | `docs/design/` | The decision log and every audit |

---

## Why kiln?

An agent can read an instruction and still ignore it. kiln takes the rules that matter out of
the prompt: a gate is a record the agent can't write, a test result is an exit code it can't
reword, and a protected branch is resolved by git. The skills make the work better, and the
hooks make sure a mistake doesn't reach you.

## How it compares

|  | Raises the quality floor | Blocks a wrong action | State survives the session | Project memory |
|---|---|---|---|---|
| [Superpowers](https://github.com/obra/superpowers) | strongest inner loop | prompt only | — | — |
| [agent-skills](https://github.com/addyosmani/agent-skills) | broadest lifecycle | prompt only | — | — |
| [BMAD](https://github.com/bmad-code-org/bmad-method) | yes | — | spec frontmatter | — |
| **kiln** | inherits both | **hooks block at runtime** | **one state file, resumable** | **grep → DNA** |

---

## Status

| | |
|---|---|
| Tests | 658, plus one case per row of the guard corpus |
| Decisions to a first PR | **5** — 3 questions `init` asks a clone, 2 gates on the `bounded` path. 7 on `full` |
| Harness | Claude Code only |
| Platform | Linux, WSL2, macOS |
| Acceptance | **6 of 6** runs done, plus [nine real checkouts](docs/design/2026-09-22-cross-project-acceptance.md) |
| **Not done** | one validation run on a production repository |

The design came before the code. The [architecture log](docs/design/2026-09-19-kiln-architecture.md)
holds 195 decisions, each with its reason.

---

## Contributing

Every fix comes with a test that fails without it. Every behaviour change gets an entry in
the decision log. Pull requests must pass `npm run lint && npm test`. See
[CONTRIBUTING.md](CONTRIBUTING.md).

If a guard allows something it promises to block, report it through [SECURITY.md](SECURITY.md).
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) covers everything else.

## Team

| | Name | GitHub | Role |
|---|------|--------|------|
| <img src="https://github.com/ttncode.png?size=120" width="60" height="60" alt="Truong Trung Nghia"> | **Truong Trung Nghia** | [@ttncode](https://github.com/ttncode) | Creator |

## License

MIT, see [LICENSE](LICENSE). Forked files and what changed in them are listed in [NOTICE](NOTICE).
