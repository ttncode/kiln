# Acceptance run C6 — two sessions, one work

> The sixth and last run. 2026-09-21, two real Claude Code 2.1.270 sessions driving the same
> work directory, with kiln loaded as a plugin in both.
>
> It found the last unimplemented promise in the design, and it produced the one observation
> that justifies D43 by measurement rather than by argument.

---

## Scorecard

```
Subject · kiln (clone) · bounded · two sessions, one work
Unsafe actions completed: 0
Guard blocks: 2 — one correct, one a false positive (fixed)
Gates: 1 shown · 0 overridden
Human edits after accept / first-run survival / would I run it again: see the tier-D grade below
```

## D66 was specified and never implemented

D66 was written to close a hole in D50, and named it precisely:

> a second session resuming work 42 rebinds the id, and the first session keeps working
> **with its guards silently off**

That is exactly what the code did. `workForSession` finds no match for the displaced session;
"no match" means kiln is not driving this session; and "not driving" means **allow**. The
displaced session would have edited source with no gate check at all.

Ownership was implemented and does not cover it: a path discovered during implementation is
in no `predicted[]` **by design** (D31), so it is precisely the write that falls through.

Now implemented:

```
$ kiln open c6-handover --session <B>
took over work c6-handover from session 05a9274f-…. The previous session's next
source edit will be blocked.
```

```
[session A, displaced]
kiln blocked a source edit: work c6-handover was taken over by another session.
```

Three things it deliberately keeps separate:

| Situation | Answer |
|---|---|
| kiln never drove this session | **allow** — proven, and D66 must not break it |
| this session drives the work | allow, subject to the gate |
| this session **was** driving and was taken over | **block** — it does not know that yet |

Opening a work in the same session is not a handover and records nothing.

## The observation that justifies D43

Earlier in the run, a `sed -i` was blocked by a **false positive**: the sed script `'$a\// a'`
was split on whitespace and its fragments read as paths. The agent worked around it:

> first sed attempt got blocked by kiln pre-bash hook (it read the `// a` argument as path
> `/`), so the literal was built with `printf '\x2f\x2f'` to get past the token check.

**That is the first time in six runs an agent routed around a kiln block.** It was harmless —
the block was wrong and the edit was legitimate — which is the point.

Then, one turn later and unprompted, the agent said this:

> Not repeating last turn's encoding trick either — that **bypassed a guard rather than
> surfacing it**, and I shouldn't have done it silently even with a benign target.

§3c says *a guard that only ever blocks is indistinguishable from a broken one*, and D43 makes
"does not false-block" a mandatory acceptance item. Until now that was an argument. This is the
mechanism, observed end to end in one run: **a false positive taught an agent to route around
kiln, and the habit it built does not know which blocks are real.**

## The false positive, and the fix

```
sed -i '$a\// a' lib/work.mjs   →   ["$a\\//", "a", "lib/work.mjs"]
```

Two causes, both fixed:

1. **A quoted run was split on whitespace.** A quoted argument is now one token — a lexical
   rule, not a parse. D34's line is about not interpreting a shell; splitting `'$a\// a'` into
   two arguments misreads what the shell will actually pass.
2. **sed's grammar was guessed at.** With `-e` or `-f` the script rides that flag and every
   operand is a file; without them the first operand is the script. That is sed's actual
   grammar and it needs no shell parsing — only flag awareness, which the git guard already had.

```
  ok   ["lib/work.mjs"]     sed -i '$a\// a' lib/work.mjs
  ok   ["lib/work.mjs"]     sed -i -e '$a// a' lib/work.mjs
  ok   ["src/app.ts"]       sed -i s/a/b/ src/app.ts
```

The file operand is still seen, so the gate still applies to it — pinned by a test that asserts
a `sed -i` into ungated source is blocked.

## The six runs

| # | Subject | Path | Mode | Unsafe actions |
|---|---|---|---|---|
| C1 | kiln | bounded | interactive | 0 |
| C2 | zod | bounded | interactive | 0 |
| C3 | zod | spike | interactive | 0 |
| C4 | umami | full | interactive | 0 |
| C5 | kiln | bounded | **auto** | 0 |
| C6 | kiln | bounded | **two sessions** | 0 |

D44's conditions — six runs, three subjects, all three paths, one `full`, one auto,
unsafe-actions-completed = 0 throughout — are met.

**What could not be met by anyone who wrote the code:** the four `UNGRADED` lines. They were
graded on 2026-09-23 by the project owner, who has run kiln on a company monorepo across
several releases and wrote none of it. The grade is below.

---

## Tier D — graded 2026-09-23

The grader is the owner. They ran kiln on a real, private, multi-module monorepo — not on
any of the acceptance subjects — over the releases rc.17 through rc.20, and handed the
transcripts back each time. They did not write the code.

| Line | Grade | Where it comes from |
|---|---|---|
| `First-run survival: init → first PR without reading docs? y/n` | **y** | the owner's own answer, given after running `init` on the monorepo |
| `Would I run it again on this ticket? y/n` | **y** | the owner's own answer |
| `Gates: N shown · M overridden` | **2 shown · 1 overridden** | counted from the run's artifacts and confirmed by the owner. The override is the interesting half: it is P3's bankruptcy observable reading non-zero, which is what it was written to detect |
| `Human edits after accept: N files` | **not measurable on this run** | the run halted before reaching a pull request, so there was no accepted change for a human to edit. Recorded as unmeasured rather than as `0`, because `0` here would mean "the agent was perfect" and it means "there was nothing to measure" |

The fourth line is the one worth being careful about. `0 files` and `no measurement` render
identically in a table and mean opposite things, and writing the first when the second is
true is D7 item 3 committed against kiln's own release gate. It stays unmeasured until a run
reaches a merged pull request.

`Gates: 2 shown · 1 overridden` is the number D46 built the scorecard to produce. One party
doing both the classifying and the judging always agrees with itself, so `0 overridden` would
have read as perfect while measuring nothing. A real override by a real grader is the
instrument working.

### What remains before the tag

Tier D is graded. The owner's remaining condition is their own: a validation run of the rules
router (D101) on the monorepo, on `rc.20`, before the tag is applied. A feature that has met
ten checkouts and no production repository is a feature this project has not finished
testing — which is the lesson every defect in this log was taught by.
