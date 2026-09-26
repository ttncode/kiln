---
name: kiln-writing-plans
description: Use when a spec or a brief describes a multi-step task and the plan gate has not been given yet, before touching code.
---

# Writing Plans

## Overview

Write implementation plans for an engineer who has not seen this codebase or this spec. Assume they write idiomatic code in the project's language once they know the exact interface and the exact test, and that they will make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and signatures, which values from the spec, which tests prove each task. Document those. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. No commits: SHIP commits the reviewed change once, by named paths.

**Announce at start:** "I'm using the kiln-writing-plans skill to create the implementation plan."

**Save the plan to:** `.kiln/work/<id>/plan.md` — the path `guard-gate` allows you to write
and the file the plan gate hashes. Print its absolute path the moment it exists.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Step Granularity

**Each step is one action with a checkable result:**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step

There is no commit step. SHIP is the run's one commit point, after review and VERIFY.

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use kiln-implement to work this plan task by task. Steps use checkbox (`- [ ]`) syntax, and a checked box is a claim kiln re-checks rather than believes.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [path to the spec/design doc this plan implements — the plan
argues from the spec, so the spec travels with it; executors read both]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

## Risk flags

[One line per flag this change carries — `- security: <why>`, `- performance:
<why>`, `- migration: <why>`, `- public-api: <why>`, `- ui: <why>` — or
`- none`. Write this section first: `kiln practices <id> --stage plan` reads
it to choose the practices this plan must follow, and refuses a plan still
being written without it. A flag you are unsure of is a flag.]

## I/O & Edge-Case Matrix

[BMAD's matrix, on `bounded` and `full`: one row per input or state the change
must handle — the happy path, then each error and boundary case — with the
expected behaviour and how an error is handled. Every row gets a test in the
task that owns the code, and kiln-implement's handover checks each ran and
passed. Delete the section when the change has no meaningful inputs; do not
write "N/A".]

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|

## Review Focus

[The five input classes or failure modes the spec implies but no task's
tests exercise that are most likely to bite a person using this software
— one line each, naming the input or condition and the behavior a
reasonable person would expect, most likely first. The spec is a vision
document: it says what the software must do, not everything it will
meet, and its silence on an input is not permission for that input to
break the program. Write the list here, once, with the spec in front of
you. Then, for each line, add the test that pins it to the task that
owns the code, in that task's own step style.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Acceptance:** [≤ 3 bullets: what is true when this task is done]
**Verification:** [the command, and the output that means it passed]
**Depends on:** [earlier tasks, or none] · **Size:** [XS 1 file · S 1–2 · M 3–5 · L 5–8; XL is two tasks]

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Implement `function(input: InputType) -> ResultType` in `exact/path/to/file.py`**

One line on the approach when the signature and the test leave a choice
(which library call, which data structure); a code block only for an
algorithm they do not determine.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

````

## What a Step Contains

A step is done when the implementer can write exactly one reasonable thing
from it. That is the whole requirement: unambiguous, not complete. Each kind
of step carries what makes it unambiguous and nothing more:

- **A test step:** the test's name and its assertions, as code, with the
  spec's exact values in them.
- **A code step:** the exact signature (name, parameters, return type), the
  file it lives in, and the specific values the spec pins. The implementer
  writes the body. A body appears only for an algorithm the signature and
  tests do not determine, or for exact copy the spec fixes.
- **A verification step:** the command to run and the output that means it
  passed.
- **A reference to another task:** that task's Interfaces block says what
  to use; the plan does not repeat that task's code.

A plan is the set of decisions the implementer cannot make alone. A plan
longer than the code it describes has written the code instead. Lines that
decide nothing ("TBD", "handle edge cases", "add appropriate validation",
"write tests for the above", a type or function no task defines) are the
opposite failure, and the self-review catches both.

## Practices

Once the header's Risk flags are written, run
`node "${CLAUDE_PLUGIN_ROOT}/bin/kiln.mjs" practices <id> --stage plan --predicted <the files the plan will touch>`
and read every file it prints before you write the tasks. Each is a practice from
superpowers, agent-skills or BMAD that applies to this change — API design, migrations,
security, observability, frontend — chosen in code from the flags and the files, not by
you. A practice it did not print does not apply; one it printed is not optional.

Files `kiln practices` may name from here — agent-skills' own, kept beside this skill:
[planning-and-task-breakdown.md](planning-and-task-breakdown.md) (always: vertical slices,
dependency order, task sizing, checkpoints),
[api-and-interface-design.md](api-and-interface-design.md),
[deprecation-and-migration.md](deprecation-and-migration.md),
[documentation-and-adrs.md](documentation-and-adrs.md),
[observability-and-instrumentation.md](observability-and-instrumentation.md) with
[observability-checklist.md](observability-checklist.md), and
[frontend-ui-engineering.md](frontend-ui-engineering.md) with
[accessibility-checklist.md](accessibility-checklist.md).

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Step scan:** Every step must let the implementer write exactly one reasonable thing, and no step may carry more than that: a line that decides nothing is a gap, a function body the signature and tests already determine is a transcript. Fix both.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Review Focus:** For each input class or failure mode the spec implies, is there a task whose tests exercise it? The five uncovered ones most likely to bite a person go in the Review Focus section, and each line there gets its test added to the owning task. An empty section means you checked and found none, not that you skipped the check.

**5. Proportion:** Compare the plan's length to the spec's. A plan several times longer than the spec it implements is a transcript of the program, not a plan. If code blocks are most of the document, replace bodies with signatures, test names and assertions, and check that each step is still unambiguous.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Handoff

Print the plan's absolute path, then hand back to the orchestrator. It renders the gate,
in the one format gates have, and records what your human partner actually said.

Do not present options for how to run the plan: the path was classified before you were
invoked, and offering a choice here would be a second gate nobody asked for.

## Common Rationalizations

| Thought | Reality |
|---------|---------|
| "The plan is obvious, I'll start while they read it" | The gate is the approval, not the plan's length. `guard-gate` blocks the edit anyway, and the block is the message. |
| "I'll fill in the details during implementation" | A step without its exact values is a decision deferred to whoever is most tired. |
| "Review Focus is empty because the spec was thorough" | Empty means you checked and found none. Write that, or write the five. |
| "I'll tidy the plan after approval" | The approval is bound to the file's hash. Editing it afterwards blocks the next source write. |
| "Two tasks are similar, I'll repeat Task 3's code" | The later task's Interfaces block names what it uses from Task 3. A repeated body is a transcript, and it drifts from the one it copied. |
| "Writing the whole body is clearer than a signature" | A body the signature and the test determine is the implementation written twice. Upstream measured the leaner plan at a quarter of the time and a third of the tokens, with no loss on planted defects. |

## Red Flags

- You are about to write a step with no `Expected:` line.
- The plan names a type, function or file that no task defines.
- A task's Interfaces block consumes something no earlier task produces.
- You are about to save the plan anywhere but `.kiln/work/<id>/plan.md`.
- A code step carries a body the signature and its test already determine.
- The plan is several times longer than the spec it implements.

## Verification

Before handing back:

- [ ] The Risk flags section names each flag with its reason, or says `- none`.
- [ ] `kiln practices --stage plan` ran after the flags were written, and every file it printed was read.
- [ ] Every spec requirement maps to a task, or the gap is stated.
- [ ] Every task carries its acceptance, verification, dependencies and size; none is XL.
- [ ] On `bounded` and `full`, every I/O & Edge-Case Matrix row is pinned by a test in the task that owns it — or the section is gone because the change has no inputs.
- [ ] Every step lets the implementer write exactly one reasonable thing: no TBD, no "add appropriate error handling", no body the signature and its test already determine.
- [ ] The plan is not a transcript of the program: its length is in proportion to the spec's.
- [ ] Types and signatures agree across tasks.
- [ ] Review Focus lists up to five spec-implied inputs no task exercises, each pinned by a test in the task that owns the code — or says it found none.
- [ ] The plan is at `.kiln/work/<id>/plan.md` and its absolute path was printed.
