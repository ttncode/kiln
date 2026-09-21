# Journey matrix — kiln as a real user meets it

**Why this exists.** Thirty-odd fixes landed in a week, and every defect among them was
found by running the product, never by reading it. Each fix was tested where it landed. What
nothing tested is whether the fixes still agree with each other — a patch to `verify` and a
patch to `ship` can each be right and together describe two different runs.

So this is not a checklist of mechanisms. It is a set of **journeys**: what a person does,
in the order they do it, with the combinations they actually hit. The executable form is
[`tests/journey.test.mjs`](../../tests/journey.test.mjs), which drives the real CLI and the
real dispatcher against real git repositories. A row here that is not a test there is a row
that proves nothing.

## What the product offers today

| Surface | Members |
|---|---|
| Commands | `/kiln:kiln init` · `/kiln:kiln <arg>` · `/kiln:kiln doctor` |
| Verbs | `init open resolve list gate ratchet halt report ship blast scope verify doctor` |
| Paths | `spike` (1 gate, no ship) · `bounded` (2) · `full` (4) |
| Modifiers | a leading path word · a leading `--auto` |
| Guards | verification · protected-branch · sandbox · gate · stack-contributed |
| Floor | a `pre-push` hook per checkout |
| Promises | D7 items 1–7 |

## The dimensions a journey crosses

| # | Dimension | Values |
|---|---|---|
| A | Project shape | single repo · superproject + submodules · no manifest kiln recognises · a repo that already has its own git hooks |
| B | Path | spike · bounded · full |
| C | How the user answers a gate | a word · a menu number · a sentence with conditions · a non-yes · a rejection |
| D | Auto | off · `--auto` in the request · `auto.*` in config |
| E | Verification | every step passes · a step fails · every step skipped · no steps at all |
| F | Adversary | each D7 item, plus the ways to switch the floor off |

## J — the journeys

Status is kept current as the suite runs: **pass**, **FAIL**, or **open**.

### J1 — first ten minutes, single repo

| # | Journey | Expected | Status |
|---|---|---|---|
| J1.1 | `init` on a Node project | config written, questions it could not answer are named, hooks installed | pass |
| J1.2 | `init` on a project with no manifest | finishes, `stack: unknown`, exit 0 | pass |
| J1.3 | `init` twice | overwrites nothing, says what it kept | pass |
| J1.4 | `doctor` on a fresh project | Ready | pass |
| J1.5 | `init --help` | prints usage, writes nothing | pass |

### J2 — a bounded change, end to end

| # | Journey | Expected | Status |
|---|---|---|---|
| J2.1 | open → brief → plan gate → edit → review gate → verify → ship | every stage gated, `scope` reconciles, `ship` names one repository | pass |
| J2.2 | a source edit before the plan gate | blocked, and blocked through a shell redirect too | pass |
| J2.3 | the artifact changes after approval | blocked — the hash no longer matches | pass |
| J2.4 | `ship` before the review gate | blocked | pass |

### J3 — how the answer is given

| # | Journey | Expected | Status |
|---|---|---|---|
| J3.1 | `approve` | recorded | pass |
| J3.2 | `1. Approve this plan as written` | recorded — the sentence is the answer | pass |
| J3.3 | a bare `1` | refused — a click is not evidence | pass |
| J3.4 | `Approve -> no need to run the suite -> ship locally` | recorded; the "no" is a condition, not a verdict | pass |
| J3.5 | `sounds good` | refused, and the re-ask offers two concrete options | pass |
| J3.6 | `3. Stop here, keep the artifacts` | recorded as a rejection | pass |

### J4 — paths and the ratchet

| # | Journey | Expected | Status |
|---|---|---|---|
| J4.1 | a spike cannot ship | blocked — no gate authorises it | pass |
| J4.2 | `full` said in the request | opened on `full`, four gates | pass |
| J4.3 | ratchet up mid-run | allowed, gates cleared, uncommitted work printed and untouched | pass |
| J4.4 | ratchet down after a gate | refused | pass |
| J4.5 | ratchet down before any gate, clean tree | allowed — classification happens after open | pass |

### J5 — auto mode

| # | Journey | Expected | Status |
|---|---|---|---|
| J5.1 | `--auto` in the request | on for that run, stated at open, not written to config | pass |
| J5.2 | `auto.bounded` in config | on for every bounded run | pass |
| J5.3 | `--auto` on a spike | refused, whatever is typed | pass |
| J5.4 | `--auto` on `full` | allowed — typing it is the opt-in `auto.full` asked for | pass |
| J5.5 | auto meeting a halt | refused | pass |
| J5.6 | what auto decided | `kiln report` lists every gate it ruled | pass |

### J6 — verification

| # | Journey | Expected | Status |
|---|---|---|---|
| J6.1 | every step passes | green, `last_verified` moves | pass |
| J6.2 | a step fails | exit 1, the tool's own output, never green | pass |
| J6.3 | every step skipped | refused — nothing verified anything | pass |
| J6.4 | no steps at all | refused, and `doctor` failed first | pass |
| J6.5 | a step whose effect nothing provides | `doctor` fails: it can never run | pass |
| J6.6 | shipped having verified nothing | allowed — the user's call — and `report` says so | pass |

### J7 — many repositories

| # | Journey | Expected | Status |
|---|---|---|---|
| J7.1 | modules detected from `.gitmodules` | no hand-written list | pass |
| J7.2 | the stack detected from a module | and the ambiguity named when several answer | pass |
| J7.3 | a push inside a submodule | judged against the submodule's branch | pass |
| J7.4 | reconciliation across submodules | files inside them are seen, committed and uncommitted | pass |
| J7.5 | ship across modules | one pull request each, sharing the topic, with the two limits printed | pass |
| J7.6 | every module's shipping branch | protected without being listed | pass |

### J8 — the adversary

| # | Journey | Expected | Status |
|---|---|---|---|
| J8.1 | D7.1 push to a protected branch | blocked in every spelling git resolves | pass |
| J8.2 | D7.2 destroy data unasked | blocked | pass |
| J8.3 | D7.3 a test that lies | the exit code decides | pass |
| J8.4 | D7.4 edit without a gate | blocked through every watched verb | pass |
| J8.5 | D7.5 write outside the sandbox | blocked; a symlink leaf is refused, not followed | pass |
| J8.6 | D7.6 network egress | a static check of kiln's own code | pass |
| J8.7 | D7.7 approve its own gate, or disarm what judges it | blocked, including `rm` of a control file or a hook | pass |
| J8.8 | the pre-push floor | a real push refused by git itself | pass |

### J9 — where the patches could disagree

The point of this file. Each row crosses two features that were fixed separately.

| # | Interaction | The question it asks | Status |
|---|---|---|---|
| J9.1 | `--auto` × `full` × ship | does an auto run reach a remote with no human at all, and is that what the design says? | open |
| J9.2 | session ownership × takeover × claim | after #69, can a second work still be opened, and does halt release the session? | open |
| J9.3 | ratchet free-move × dirty tree | does an untouched-work move stop being free the moment the tree changes? | open |
| J9.4 | half-made work × doctor × list | is a directory with no state a warning, and does the session keep running? | open |
| J9.5 | init ambiguity × step derivation × verify | if detection is ambiguous, does the config it writes still verify? | open |
| J9.6 | submodule × scope × ship × dirty_at_open | do `scope` and `ship` agree about which files are this run's? | open |
| J9.7 | skipped step × isGreen × report | do the three agree that nothing ran? | open |
| J9.8 | protected set × modules × doctor | does the derived set agree with what the guard enforces? | open |
| J9.9 | `--auto` × gate classifier × menu number | does an auto-ruled gate record words rather than a click? | open |
| J9.10 | pre-push floor × protected set × submodule | does the floor use the same protected set the guard does? | open |

## What this matrix deliberately does not cover

- **The four human-graded scorecard lines.** They need a person who did not build it.
- **The interpreter ceiling.** `python -c` and heredocs into scripts are a stated limit,
  tested as a limit rather than as a promise.
- **A real forge.** Nothing here pushes to GitHub or GitLab; `ship` is checked as a plan.
