---
name: kiln-review
description: Use when implementation is finished and the change needs judging before it ships. Reviews the whole diff against the plan, grades findings by severity and likelihood, and reconciles what the plan predicted against what was touched.
---

# kiln Review

## Overview

One fresh read of the whole change, by someone who did not write it. That is the only
thing this stage buys, and the author cannot buy it for themselves: same author, same
blind spots.

**Core principle:** grade what a person using this software gets, not whether the plan
happened to name the input that breaks it.

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

### 2. Read the change, then judge it

Use [code-reviewer.md](code-reviewer.md) for how to read a diff and what to say about it.

Two rules kiln adds:

**Grade on two axes, not one.** Severity alone lets a catastrophic-but-impossible
finding outrank a certain-but-moderate one, and improbable findings then block merges.

| | Likely | Possible | Unlikely |
|---|---|---|---|
| **Critical** | fix now | fix now | discuss |
| **Important** | fix now | discuss | note |
| **Minor** | note | note | drop |

**There is no minimum number of findings.** Zero is a valid result. A quota manufactures
findings, and a manufactured finding costs someone a real fix pass.

### 3. Say what you declined to judge

Behaviour the plan does not mention is judged by what a reasonable person using this
software would expect — silence in a plan is not permission for an input to break the
program. Where you decided that was not yours to call, list it under **Declined to
judge**, and the orchestrator puts each line to your human partner.

### 4. Write it down

`.kiln/work/<id>/review.md`: the findings with both grades, the Declined to judge list,
and the reconciliation line. Print its absolute path. Then hand back to the orchestrator,
which renders the review gate.

## Common Rationalizations

| Thought | Reality |
|---------|---------|
| "I wrote it, so I know it's fine" | You know what you meant. The review is about what you wrote. |
| "The plan didn't mention that input, so it's Minor" | That grades the plan's silence, not the effect. Grade what the person gets. |
| "A review with no findings looks lazy" | A quota manufactures findings. Zero is a result; say it plainly. |
| "This finding is theoretically possible" | Then it is Unlikely, and the table says what that is worth. |
| "Scope went beyond the plan, so something is wrong" | Divergence is reported, not blocked. Read those files first, then judge them like any other. |
| "I'll fix it while I'm reviewing" | Then nobody reviewed the fix. Record it; the fix pass is a separate act. |

## Red Flags

- You are the author and you are about to call this the fresh read.
- Every finding is Critical.
- You are counting findings to reach a number.
- `actual 0` and you are reviewing anyway.
- A finding names no file and no line.

## Verification

- [ ] `kiln scope <id>` ran, and its line is in `review.md`.
- [ ] Every finding carries a severity **and** a likelihood.
- [ ] Declined to judge is present, even if empty — empty means you checked.
- [ ] `review.md` exists and its absolute path was printed.
- [ ] You did not fix anything during the review.
