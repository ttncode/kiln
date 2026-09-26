---
name: kiln-review
description: Use when implementation is finished and the change needs judging before it ships.
---

# kiln Review

## Overview

Fresh reads of the whole change, by readers who did not write it. That is the only thing
this stage buys, and the author cannot buy it for themselves: same author, same blind spots.

**Core principle:** grade what a person using this software gets, not whether the plan
happened to name the input that breaks it.

The readers are the sources' own (D189): BMAD's four review lenses and agent-skills' `/ship`
specialists, beside superpowers' reviewer. Each reads the change with a different method, so
what one misses another is built to catch.

## When to Use

- After IMPLEMENT has handed over, on the `bounded` and `full` paths.

**When NOT to use:** on `spike`. Its output is an answer, and it does not ship.

## Process

### 1. Read the reconciliation first

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/kiln.mjs" scope <id>
```

It reports and does not block — discovery during implementation is legitimate. Two
things do matter:

- **`actual 0` halts.** Nothing changed in this range, and the usual cause is a commit
  on another branch. Do not review the absence of the thing under review.
- **Files beyond prediction** are where an investigation was wrong. Read those first.

### 2. Ask which readers this change gets

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/kiln.mjs" practices <id> --stage review
```

It names the readers, each with what selected it, and writes their inputs — the diff, the
claims, the intent — to `.kiln/tmp/<id>/review/`. Which readers run is decided in code, from
the change itself: agent-skills' specialists are skipped only on its own `/ship` rule (two
files or fewer, under 50 lines, touching nothing sensitive), and the performance reader runs
when the plan flags performance or the diff reads in a loop.

### 3. Launch every reader at once

[readers.md](readers.md) holds each reader's launch prompt. Launch all of them in one
message, each as a `general-purpose` subagent, and do not read or react to any report until
every one has returned:

```
Task(subagent_type: "general-purpose", prompt: <the reader's launch prompt, filled in>)
```

The prompts are the readers' instructions, not a checklist for you. Reading them yourself
and reviewing your own diff is the one thing this stage cannot buy — on the first real
full-path run the implementer reviewed itself because this step said "use" where it meant
"dispatch".

A subagent is safe here and it was measured, not assumed: `PreToolUse` hooks fire inside
one and block there, and its `session_id` is the parent's — so `guard-gate` still matches
this work and the reviewer cannot edit past a gate either (§1.6 findings 7 and 8). Each
reader is told not to dispatch further; that instruction is for the reader.

A reader that fails, times out or returns nothing is marked failed. Carry on with the rest,
and never report the review as clean while a reader failed.

### 4. Triage — once every reader has reported, and not before

BMAD's triage, applied by you:

- **Disregard any severity a reader assigned** — readers lack the context to grade. You grade.
- **Verify each finding.** At the cited file and line, does the bad outcome it describes
  actually occur? Read beyond the changed lines: follow callers and the guards upstream. Code
  that loudly fails on a situation you never showed the program can reach is correct
  behaviour, not a defect. Verification-gap findings arrive verified; take them as filed.
- **Give each one verdict:** a grade on the two axes below, or `false` with the disproof, or
  `maybe-false` with what would settle it. A `false` finding is dropped with its reason shown.
- **Group by root cause.** Same location alone is not a shared root cause, and neither is a
  shared fix.
- **Every finding gets a row** in review.md's triage log — never dropped, merged or skipped
  silently.

**Grade on two axes, not one.** Severity alone lets a catastrophic-but-impossible
finding outrank a certain-but-moderate one, and improbable findings then block merges.

| | Likely | Possible | Unlikely |
|---|---|---|---|
| **Critical** | fix now | fix now | discuss |
| **Important** | fix now | discuss | note |
| **Minor** | note | note | drop |

Grade by effect: the spec is a vision document, and a finding's grade is what a reasonable
person using this software gets if it ships, not whether the spec names the input that
triggers it.

**There is no minimum number of findings.** Zero is a valid result. A quota manufactures
findings, and a manufactured finding costs someone a real fix pass.

### 5. Route each finding

| Route | When | What happens |
|---|---|---|
| **fix pass** | a *fix now* cell, and the fix is a direct correction that adds no public surface and guards no state you did not demonstrate | step 6 |
| **deferred** | pre-existing in code this change did not introduce, or the fix belongs in the project's agent instructions | review.md's Deferred list |
| **intent gap** | the change implements another reading of what was asked | save the diff as a patch under `.kiln/tmp/<id>/`, then `kiln halt <id> --kind blocking_unknown --reason "<the question>"`; your human partner answers it |
| **bad plan** | the plan itself was wrong | a **Plan Change Log** entry in plan.md — the finding, what was amended, the known-bad state it avoids, what to KEEP — then the plan gate again, which is your human partner's yes |
| **discuss / note** | the other cells | review.md, with the reason, for the gate |

Nothing is reverted automatically. On kiln's uncommitted tree a revert destroys work, and a
changed plan is a person's decision.

### 6. The fix pass — once

superpowers' Final Review, restored. Fix the findings routed here yourself, in ONE pass.
Each fix is verified by TDD, not by a second reviewer: write the test that reproduces the
finding, watch it fail, make it pass, then run the whole suite. Record each in review.md as
`fixed <finding> — <test name> RED→GREEN, suite <N>/<N>`. A fix without a test that failed
first is not verified; a suite that is not green after the pass means the pass is not over.
Do not dispatch a re-review, and there is no second fix pass.

A *fix now* finding you decide not to fix is a ruling — `Ruling: <finding> — <why the code
stands> — <cost if wrong>` — and your human partner sees it at the gate.

### 7. Say what you declined to judge

Behaviour the plan does not mention is judged by what a reasonable person using this
software would expect — silence in a plan is not permission for an input to break the
program. Where you decided that was not yours to call, list it under **Declined to
judge**, and the orchestrator puts each line to your human partner.

### 8. Write it down

`.kiln/work/<id>/review.md`, in this order:

- `lenses:` then every reader `kiln practices` named, each `reported` or `failed` —
  `lenses: reviewer reported, blind-hunter reported, …`. The review gate reads
  this line and refuses one that leaves a named reader out.
- the reconciliation line;
- the triage log, one row per finding: reader, location, verdict, grade, route;
- Fixed, Rulings, Deferred, Declined to judge.

Print its absolute path. Then hand back to the orchestrator, which renders the review gate.

## What ships with this skill

- [readers.md](readers.md) — each reader's launch prompt; [code-reviewer.md](code-reviewer.md) — superpowers' reviewer template.
- `lenses/` — BMAD's blind hunter, edge-case hunter, verification-gap reviewer and intent-alignment auditor.
- `personas/` — agent-skills' code-reviewer, security-auditor, test-engineer and web-performance-auditor.
- agent-skills' skills the readers apply: [code-review-and-quality.md](code-review-and-quality.md), [security-and-hardening.md](security-and-hardening.md) with [hardening-patterns.md](hardening-patterns.md), [performance-optimization.md](performance-optimization.md); and its checklists, [security-checklist.md](security-checklist.md) and [performance-checklist.md](performance-checklist.md).

## Common Rationalizations

| Thought | Reality |
|---------|---------|
| "I wrote it, so I know it's fine" | You know what you meant. The review is about what you wrote. |
| "One reader is enough for a change this size" | `kiln practices` decides that from the change, on the sources' own rule. Launch what it names. |
| "The plan didn't mention that input, so it's Minor" | That grades the plan's silence, not the effect. Grade what the person gets. |
| "A review with no findings looks lazy" | A quota manufactures findings. Zero is a result; say it plainly. |
| "This finding is theoretically possible" | Then it is Unlikely, and the table says what that is worth. |
| "The reader said Critical" | Readers do not grade; you do, after checking it at the line. |
| "Scope went beyond the plan, so something is wrong" | Divergence is reported, not blocked. Read those files first, then judge them like any other. |
| "I'll fix it while I'm reading the reports" | Triage first, every report in. The fix pass comes after, once, with a failing test per fix. |
| "The fix is obvious, no need for a failing test first" | A fix with no test that failed first is not verified. |

## Red Flags

- You are the author and you are about to call this the fresh read.
- You launched fewer readers than `kiln practices` named.
- You acted on one report before all of them were in.
- Every finding is Critical.
- You are counting findings to reach a number.
- `actual 0` and you are reviewing anyway.
- A finding names no file and no line.

## Verification

- [ ] `kiln scope <id>` ran, and its line is in `review.md`.
- [ ] `kiln practices <id> --stage review` ran, and every reader it named was launched.
- [ ] The `lenses:` line names every one of them, `reported` or `failed`.
- [ ] Every finding has a row in the triage log, with a verdict, and a severity **and** a likelihood unless it is `false`.
- [ ] Every fix is recorded RED→GREEN with a green suite; every *fix now* not fixed is a ruling.
- [ ] Declined to judge is present, even if empty — empty means you checked.
- [ ] `review.md` exists and its absolute path was printed.
