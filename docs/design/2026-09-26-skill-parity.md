# Skill parity with superpowers, agent-skills and BMAD

> **Status: plan, revised twice after adversarial reviews; not yet built.** Written 2026-09-26
> after the owner asked why agent-skills lists four skills for REVIEW and kiln has one. Every
> claim was read in the sources at the commits below. The last section lists what the two
> reviews found and how each finding was answered.

## The owner's terms

1. kiln works on its own. Nothing it needs lives in another plugin.
2. What kiln takes from open source is cloned as the source wrote it, and changed only where it
   has to be for kiln to run it correctly. Each change is recorded.
3. The bar is the source's quality first. Better comes after that, and never instead of it.
4. Every stage is in scope, and every item in each source is placed: adopted, or declined with
   a reason.

Term 3 sets the shape of this plan. **Phase A** reaches the sources' level with their own
content and the least new code. **Phase B** goes past them with new mechanisms. Each Phase B
mechanism gets its own design and its own adversarial review before any code, because the
second review of this plan showed each one carries risks the content work does not: to kiln's
state, to the user's uncommitted files, and to the gates.

## Sources read

| Source | Commit | Licence | Contents |
|---|---|---|---|
| addyosmani/agent-skills | `2686b62` (0.6.11) | MIT | 25 skills, 4 personas, 7 references, 9 commands, hooks, scripts, evals, per-harness configs |
| obra/superpowers | `8ca22db` (v6.4.2) | MIT | 15 skills with bundled prompts and scripts, tests; kiln forked five at v6.4.1 (D69) |
| bmad-code-org/BMAD-METHOD | `5e33d3c` (6.13.0-next) | MIT; the BMad marks are not (TRADEMARK.md) | 30 skills, 6 web bundles, tools, docs |

## Where kiln stands

**Where kiln is ahead.** It enforces what the sources only write down:

- Gates are hashed to the documents they approve (D139).
- Project rules are routed by path in code, and the review gate refuses until they are read
  (D101, D115).
- VERIFY runs after the review gate and sends the work back on a failure.
- Review findings carry a likelihood as well as a severity (D75).
- Hooks block unsafe actions, inside subagents too.

The sources have some mechanism too. superpowers' `task-done` records exit codes, which is the
shape D65 copied. agent-skills documents a floor-guard reference implementation. BMAD reads an
empty lens result as valid.

**Where kiln is behind** is the method its prompts carry.

1. **REVIEW is one generic reader.** Its whole treatment of security and performance is two
   questions. Each source reviews with several readers:
   - BMAD's thorough review runs four lenses, and its triage verifies each finding at the
     cited line.
   - agent-skills' `/ship` runs security, test and code-review specialists by default and
     requires a rollback plan before GO.
2. **The superpowers fork fell behind, and lost one thing without a decision.**
   - writing-plans v6.4.2 is missing. Upstream measured it at "a quarter of the time and about
     a third of the tokens", 9/9 on planted-defect probes.
   - D69 cut executing-plans' Final Review whole, which took the fix pass with it, yet
     kiln-review still refers to a fix pass.
   - NOTICE records the four debugging technique files as not carried, but its "restated
     inline" overstates what stayed.
   - The reviewer is dispatched with no Review Focus, no rulings and no model.
3. **Whole practices are missing.** None of these has guidance in kiln today:
   - security hardening, performance, API design, migrations, observability, frontend;
   - source-grounded framework code, in-flight doubt, incremental slicing, simplification,
     change sizing;
   - a clean baseline, claim discipline beyond tests, parallel dispatch;
   - replying to review comments.
4. **Two decisions dropped something with no replacement.**
   - D69 dropped superpowers' per-task review (subagent-driven development) and
     verification-before-completion.
   - D142 removed agent-skills' save points (a commit to return to).
   - kiln never had BMAD's Plan Change Log.

**Two corrections to the record.**

- **D142 misreads agent-skills.** D142 says agent-skills leaves the tree uncommitted until the
  work is done. It commits every slice (incremental-implementation step 4; `/build auto`: "make
  one commit per task"). The ruling stands on BMAD, which commits once, and on the owner's
  choice.
- **D21 was only half adopted.** It took interview-me's Q + GUESS, its restate ending in *Out
  of scope*, and its three-question stop. None of these reached a skill.

# Phase A — reach the sources' level

## Packaging: a routed file per source skill

**Why not more skills.**

- A model-invocable skill costs its description on every request.
- kiln's cap is 6,000 characters (`tests/skills.test.mjs`) and it uses 1,664. agent-skills' 25
  descriptions alone are 8,691.
- `disable-model-invocation` also hides a skill from the orchestrator.
- Description routing did not fire for kiln's stage skills: "only this skill ever loaded, and
  the other six sat unread" (kiln-orchestrator).

**The shape.** Each adopted source skill becomes a file bundled under the kiln skill that owns
its stage, for example `skills/kiln-review/lenses/edge-case-hunter.md`. It costs nothing until
read.

**Routing.** `kiln practices <id> --stage <stage>` prints the files that stage must read for
this work, and records the list in state.

### Triggers

| Trigger | Checked by | When code cannot tell |
|---|---|---|
| `always` | — | — |
| path glob over the plan's predicted files or the diff | code (D101's matcher) | — |
| content pattern over the diff, for example string-built SQL or `fetch` of a variable | code (a stack's `files` + `contains` regex, as `dna.surfaces` uses) | a stack with no pattern fires the file |
| DNA surface kind the change reaches: API, SCREEN, BATCH, ENTITY | code | no DNA store: the file fires |
| a risk flag: security, performance, migration, public-api, ui | the plan's **Risk flags** section, which `kiln practices` parses | a plan without the section is refused by `kiln practices`, so "none" must be written |
| diff size: files, and lines including untracked files | code, `git diff --numstat` plus a line count of untracked files | — |

The rule for uncertainty is **fire, don't skip.** A file is left out only when code can say it
does not apply.

**Where the Risk flags live.** The section is in plan.md, so the plan gate hashes it and the
user sees it when approving. A risk found during IMPLEMENT is recorded as a ruling in the
ledger, not by editing plan.md, because editing an approved plan un-binds its gate.

### What the review gate checks

It refuses in two cases:

- until `kiln practices <id> --stage review` has run, the same hole D115 closed for rules;
- until `review.md` has a `lenses:` line naming every reader the list required, with each one
  marked `reported` or `failed`.

A failed reader never counts as a clean pass. The gate still records, and the summary shows the
failed reader to the user.

This proves the list was made and each reader's report was filed. It does not prove a model
read a file with care, and the text does not claim that.

## Faithful copies

**The note.** A copy is the source file under a kiln note of a few lines, naming the source,
the commit and every override.

**When the body is edited.** Only when at least one of these holds:

1. It would make the agent do what kiln forbids:
   - commit before SHIP;
   - write outside `.kiln/work/<id>/` before a gate;
   - pause IMPLEMENT to ask a question (kiln-implement's continuous execution);
   - add a gate or path choice of its own;
   - create tracker items (D13);
   - deploy.
2. It is a step the agent will execute, which a note cannot reliably override.
3. It names a skill, script, path or command that does not exist in kiln. Examples: a bare
   sibling skill name, `bash scripts/…`, `npm test` where the stack's command belongs, `/review`.

**Excerpt, not edit.** Where most of a file is overridden, only the named sections are taken,
and the rest of the file is declined in writing. This applies to git-workflow-and-versioning,
shipping-and-launch and spec-driven-development.

**What NOTICE records.** Every edit and excerpt, per file, with two hashes:

- the upstream file's sha256, for drift;
- kiln's body's sha256, for tamper.

**What checks it.**

- `scripts/upstream.mjs` generalises `dna-upstream.mjs` (D167) to report upstream changes since
  the fork.
- Two tests: one for the hashes, and one for names. The name test extends the foreign-namespace
  test to bare agent-skills skill names and `bash scripts/` paths.

**What is not taken.**

- BMAD's `_bmad/` Python runtime (D2). Its Jinja-templated prompts are resolved by hand, and
  NOTICE records that the BMad marks are not licensed, as D11 did for superpowers.
- New shell scripts, unless they are kept as bash in the brainstorming-scripts shape and added
  to CI's shellcheck line.

## REVIEW

### Route

BMAD separates who implements (`route_selection`: 100 estimated lines or fewer, not more than
five files, and "not simple or mechanical", means oneshot) from how deep the review goes
(thorough by default in bmad-code-review; "about 100 lines" in its help page). kiln's mapping
is its own and measured on the actual diff:

- **Quick:** 100 changed lines or fewer and 5 files or fewer. The general reviewer runs, with
  BMAD's quick lens folded in: the plan, the project rules, and bugs.
- **Thorough:** anything else.

### Readers

The stage dispatches readers in parallel. No reader dispatches another, which is every
source's rule.

| Reader | From | Runs |
|---|---|---|
| general reviewer: agent-skills' code-review-and-quality (five axes, change sizing, tests first, presumptive blockers, dependency discipline) merged with superpowers' code-reviewer.md | AS + SP | always |
| blind hunter, without either quota line (the floor N, and "do not stop with an empty list"; D75) | BM | thorough |
| edge-case hunter + deletion check + claims check, from the bmad-code-review variant; the claims read the plan's Goal, Global Constraints and Review Focus and brief.md, only after tracing | BM | thorough |
| verification-gap hunter, with the test-engineer's scenario table folded in (no separate test seat) | BM + AS | thorough |
| intent-alignment auditor, reading the plan's gate-hashed Goal as the intent, the way BMAD reads its approved, frozen Intent, and brief.md as context | BM | thorough |
| security-auditor + security-and-hardening + hardening-patterns + security-checklist | AS | on by default; skipped only when `/ship`'s rule holds: 2 files or fewer, under 50 lines, and nothing in auth, payments, data access or config |
| performance-optimization + performance-checklist, plus web-performance-auditor for web surfaces | AS | the performance flag, or a content pattern (a query in a loop, an unbounded fetch) |

**How many readers.** A quick change runs 1 reader, or 2 with security. A thorough one runs 5,
6 with security, and up to 8 with both performance files. BMAD thorough runs 4 and `/ship`
runs 3. The Phase A measurement decides whether each reader earns its seat; one that never
catches what the others miss is removed.

### Severity and triage

Readers report findings without grading them. This is BMAD's "disregard any severity a
reviewing subagent assigned — they lack the context to grade", and its lens prompts already
say "do not assign severity labels". The copies of agent-skills' and superpowers' reviewer
prompts get that one edit. The author of `review.md` grades on kiln's two axes.

Triage is BMAD's, applied by that author:

- Verify each finding at its file and line, reading beyond the changed lines. Verification-gap
  findings are exempt, since they arrive verified, as in BMAD.
- Mark each finding `false` (with the disproof) or `maybe-false` (with what would settle it),
  and drop those with the reason shown.
- Group findings by root cause.
- Give every finding one row in review.md's triage log, never dropped or merged silently.

### Routing and the fix pass

| BMAD route | In kiln |
|---|---|
| patch: "smallest fix is trivial, adds no public surface, guards no state" | the fix pass, for findings in kiln's *fix now* cells only |
| defer: pre-existing issues, and fixes that edit agent-context files | review.md's Deferred list |
| intent gap | save the attempted diff as a patch under `.kiln/tmp/<id>/` (build-auto does this for intent gaps), then halt with `blocking_unknown` and put the question to the user |
| bad plan | a Plan Change Log entry in the plan (the finding, what was amended, the known-bad state avoided, KEEP instructions), then the plan gate again, which is a person's yes |

Nothing is reverted automatically. BMAD's revert-and-retry loop is declined:

- on kiln's uncommitted tree a revert destroys data (D7 item 2);
- a plan change is a person's decision (D139).

**The fix pass** is superpowers' Final Review, restored.

- It runs once, after grading and before the review gate, while source is still open.
- Each fix is RED→GREEN with a green suite, written in review.md as `fixed <finding> — <test>
  RED→GREEN`.
- There is no second pass and no re-review.
- Every finding not fixed becomes a ruling shown to the user at the gate, as upstream's
  `Ruling:` lines are.
- The hashed review.md describes the diff the user approves.

kiln-review's two lines that forbid fixing during review are rewritten to fit this: its
verification line "You did not fix anything during the review", and its rationalization "I'll
fix it while I'm reviewing".

**Kept from kiln:**

- likelihood as well as severity;
- no minimum number of findings;
- Declined to judge;
- `kiln scope` reconciliation;
- the hashed review.md;
- VERIFY after the gate.

## Stage by stage

Legend: **SP** superpowers · **AS** agent-skills · **BM** BMAD. *Italics* = a trigger routed by
`kiln practices`.

### INVESTIGATE and DEFINE

| Adopt | From | Trigger | Edits |
|---|---|---|---|
| interview-me | AS | *brief lacks who, why, success or constraint* (fields the brief now requires), or the user asks; never under `--auto` | save path → `.kiln/work/<id>/`; the "offer downstream paths" step removed (kiln's path is already chosen) |
| idea-refine + frameworks, refinement-criteria, examples | AS | *spike path*, or the user asks | the script call removed; `docs/ideas/` → `.kiln/work/<id>/` |
| spec-driven-development, **excerpt**: the six areas, Always/Ask/Never boundaries, assumptions, success criteria | AS | *full* | Phase 0's root-level files, Phases 2–4 (kiln's own stages) and "this skill owns the gates" are declined |
| spec kernel: the preservation pass against the request, non-goals, success signal, domain-gap rule | BM | *full* | kiln's own text, citing bmad-spec |
| architecture adversary: "two units that obey every decision yet build incompatibly" | BM | *full*, in the spec reviewer prompt | kiln's own text, citing bmad-architecture |
| "several defensible readings → halt, do not pick one" | BM (build-auto) | *auto* | replaces brainstorming's "pick one and make it explicit" under auto only |
| context-engineering | AS | `kiln init` and rule authoring | rules-file paths → `kiln rules add` |
| constraint-driven-development | AS | `kiln init` | its dimensions map onto stack steps and the `fast`/`full` phases; only tools the project already runs are offered (D173); no writes to AGENTS.md or CLAUDE.md; no commit-message waivers |
| a PRD or UX document the project already has | BM (bmad-build step 1 reads them) | INVESTIGATE | read, never written |

### PLAN

| Adopt | From | Trigger | Edits |
|---|---|---|---|
| writing-plans v6.4.2 | SP | always | fork sync, keeping kiln's D142/D66/path edits |
| planning-and-task-breakdown | AS | always | its per-task fields (acceptance criteria, verification, files, estimated scope, dependencies) are added to kiln-writing-plans' task format, which stays the one template; `tasks/` → plan.md; tracker items (D13) and human checkpoints every 2–3 tasks removed, its verification checkpoints kept; step sizing is superpowers' "one action with a checkable result", task sizing is agent-skills' XS–L |
| I/O & edge-case matrix, and the Matrix Test Audit before handover | BM | *bounded, full* | kiln's own text, citing bmad-build |
| a required Risk flags section | kiln | always | — |
| api-and-interface-design | AS | *API surface*, *public-api* | — |
| deprecation-and-migration | AS | *migration globs*, *ENTITY surface*, *migration* | — |
| documentation-and-adrs | AS | *full*, *public-api* | ADR location: the project's own convention, else `docs/decisions/`, written as part of the change |
| observability-and-instrumentation + checklist | AS | *API or BATCH surface* | — |
| security-and-hardening, threat-model half | AS | the security trigger | — |
| frontend-ui-engineering + accessibility checklist | AS | *UI globs*, *SCREEN surface*, *ui* | — |

### IMPLEMENT

| Adopt | From | Trigger | Edits |
|---|---|---|---|
| incremental-implementation | AS | always | every commit instruction (step 4, granularity, "committed with a descriptive message", the uncommitted-changes red flag, the verification lines) → "the task ends green and recorded"; "Want me to create tasks?" → a ledgered ruling |
| clean baseline before task 1: `kiln verify --phase full` at the start, recorded, so a later failure is not blamed on the change | SP (using-git-worktrees step 3, taken alone) | always | the rest of using-git-worktrees is declined; agent-skills' "tree must be clean" is not taken (kiln allows a dirty tree at open) |
| test-driven-development (Prove-It, pyramid, sizes, DAMP) + testing-patterns | AS | always | where it differs from superpowers' Iron Law, the Iron Law's step stays and the other is removed |
| revert-must-fail regression proof | SP (verification-before-completion) | a bug fix | in kiln-tdd; the fix is undone and restored by edits, since the tree has no commit to revert to |
| root-cause-tracing, defense-in-depth, condition-based-waiting + example, find-polluter | SP | any failure | find-polluter stays bash, taking the command for one test file as an argument instead of `npm test`; `npm test` literals → the stack's command |
| debugging-and-error-recovery | AS | any failure | `npm test` → the stack's command; `git bisect` is kept for commits that exist, and never moves HEAD during a work |
| dispatching-parallel-agents | SP | two or more independent failures | — |
| source-driven-development | AS | *the diff imports a third-party package*, or the spike path | the sdd-cache hook not taken (bash, egress); deep-recon's technical-pack epistemics added ("never conclude from training data alone", a claims ledger) |
| doubt-driven-development | AS | *security or migration flag*, *irreversible-operation patterns* | the mid-run question to the user, which includes the cross-model offer, is removed: IMPLEMENT does not pause, and under `--auto` the answer is always no. Persona and `/review` names mapped to kiln-review |
| code-simplification | AS | always, scoped to the diff, before handover | the simplify-ignore hook not taken (D65) |
| browser-testing-with-devtools | AS | *UI globs*, and the DevTools MCP is present | — |
| ci-cd-and-automation | AS | *CI and deploy globs* | — |
| verification-before-completion (claims beyond tests: requirements line by line, no "should") | SP | always, at handover | supersedes D69's drop by a decision entry: exit codes cover tests, not claims about requirements |
| definition-of-done | AS | always, at handover | — |

### VERIFY and SHIP

| Adopt | From | Trigger | Edits |
|---|---|---|---|
| git-workflow-and-versioning, **excerpt**: message conventions, the "things I didn't touch" summary, pre-commit hygiene, change sizing | AS | always, at SHIP | commit cadence, save points and worktrees declined |
| shipping-and-launch and `/ship`, **excerpt**: the rollback plan (trigger conditions, exact steps, recovery time) and the GO/NO-GO summary in the PR body; Critical findings mean NO-GO unless the user accepts them; the accessibility, infrastructure and documentation checks | AS | always, at SHIP | deploys, rollout stages, flag operations and `git revert && git push` declined: kiln ends at a pull request |

## Not adopted, and why

**agent-skills**

| Item | Why |
|---|---|
| using-agent-skills; `hooks/session-start.sh` | A router. kiln routes in code, and a second router is the double routing D62 cites (agent-skills #569). Their own doc calls the hook "a standalone helper for hosts without native skill routing … not wired by either plugin". |
| sdd-cache and simplify-ignore hooks | Bash with jq and curl, and egress from kiln's own code; simplify-ignore rewrites source outside any gate (D65). |
| orchestration-patterns.md | Taken as one rule: readers do not dispatch readers. Its anti-pattern C, an orchestrator that removes the user's checkpoints, is what kiln's recorded gates answer, except in auto mode, which the user turns on. |
| the four personas | Folded into the REVIEW readers. "Always include at least one positive observation" is dropped as a quota (D75). |
| the 9 commands | Their equivalents are kiln's stages: `/spec` → full-path spec, `/plan` → PLAN, `/build` → IMPLEMENT, `/test` → kiln-tdd, `/review` and `/ship` → REVIEW and SHIP, `/code-simplify` → the simplification pass, `/constraints` → init, `/webperf` → the performance reader. |
| `scripts/`, `evals/`, `docs/`, per-harness configs (`.agents`, `.codex-plugin`, `.gemini`, `.opencode`, `commands/*.toml`) | Their own tooling and other harnesses. The evals feed the measurement below. |

**superpowers**

| Item | Why |
|---|---|
| using-superpowers, its references, its SessionStart hook | A router; same reason. |
| using-git-worktrees, except step 3 | kiln does not require a worktree (D66) and supports one (D100). |
| finishing-a-development-branch | Local merge and cleanup; kiln ends at a pull request, and VERIFY runs the suite. |
| requesting-code-review SKILL.md | Replaced by kiln-review; its code-reviewer.md is kept. |
| writing-skills, diagnosing-superpowers, systematic-debugging's pressure tests, test-academic and CREATION-LOG, `tests/` | Tools for building and testing a skill pack. `tests/systematic-debugging/test-find-polluter.sh` comes along with find-polluter. |
| subagent-driven-development | Phase B. |

**BMAD**

| Item | Why |
|---|---|
| PRD, product brief, PRFAQ, UX, ticketing, party mode, forge-idea, ideation brainstorming, advanced elicitation, correct-course, retrospective, personas, `bmad`, `bmad-customize`, bmod-core-tools, bmod-method help, web bundles, `tools/`, `docs/`, `removals.txt` | Product and project management around the loop, or BMAD's own tooling. Ticketing is D13. |
| architecture spine | Project-wide, not per ticket; its adversary check is adopted into the spec reviewer. |
| bmad-review's structure and prose lenses | Editorial review of prose; its adversarial lens is the blind hunter. |
| bmad-build steps 1–3 and 5, the oneshot step, the plan template's frozen block and Code Map | kiln's own classification, gates (hash-bound, which covers what the frozen block protects), plan format and SHIP. The route thresholds, the Plan Change Log, the I/O matrix and the Open-Questions halt are taken. |
| bmad-build's single fresh implementer subagent | Phase B, with subagent-driven development. |
| code-review step 1's file grouping above ~3000 lines, and step 4's apply-all / walk / leave menu | Grouping is taken into the thorough route. The menu is kiln's review gate. |
| `review_loop_iteration` cap | Only BMAD's revert-and-retry loop needs it, and that loop is declined. |
| walkthrough | Phase B. |
| project-context adopt, refresh and audit | It rewrites and prunes AGENTS.md, which kiln leaves to the user; its verified-command rule is D173. |
| qa-generate-e2e-tests | Tests written after the code, which the Iron Law forbids; a browser run is a stack step (D73). |
| deep-recon's non-technical packs | Research outside engineering. |
| decision_needed | kiln's Declined to judge. |

## Measuring Phase A

**What is measured.** What each stage's prompts catch or produce, run directly as subagent
prompts over fixtures. A full kiln run needs `kiln init`, gates and a person's yes in each
fixture, and the sources' own graders mostly grade format and process, not catches.

**REVIEW.** Planted-defect fixtures, one defect each, of the kinds the readers exist for:

- an unhandled branch;
- a deleted guard;
- a test that passes with the feature missing;
- a diff implementing another reading of the request;
- string-built SQL;
- an N+1 query;
- a secret in code;
- an unbounded fetch.

agent-skills' own review fixtures are included too: `user-search.diff`, the security webhook,
the performance query.

**Three arms per fixture:**

1. today's kiln reviewer;
2. the sources' readers, the same prompts unedited, with BMAD's templates resolved;
3. the new kiln REVIEW.

**The bar and how it is run.**

- The new REVIEW must catch every planted defect at least as often as the sources' readers,
  and never less often than today's kiln.
- Each arm runs 9 times per fixture (agent-skills' own firing tests use counts of that order),
  on a pinned model.
- A fresh grader checks each run's report for the planted defect by location and consequence.
- The Claude Code version, model and counts go into `docs/design/`.

**Other stages.** Each gets fixtures of the same kind, adapted from agent-skills' `evals/`
where one exists. Expectations that require what kiln forbids, such as commits per slice or
`tasks/plan.md`, are rewritten to kiln's equivalent, and each rewrite is recorded.

superpowers' own evals live in a separate repository and are not in this clone. The
writing-plans sync is therefore measured on the same planted-defect method its release notes
describe, rather than re-run against their suite.

**Deterministic tests** cover everything code decides:

- every trigger;
- the plan's Risk flags parse;
- the gate's two refusals;
- both hashes of every copy;
- the name test;
- the description budget.

## Order of work (Phase A)

One pull request per commit, each with its decision entry. Each step lands only when the ones
before it are merged.

0. **Fixtures and the baseline:** today's kiln reviewer, and the sources' readers, measured.
   Nothing in kiln changes.
1. **Copy infrastructure:** `scripts/upstream.mjs`, both hashes, the name test.
2. **Fork repair:**
   - writing-plans v6.4.2;
   - the four debugging files and find-polluter restored;
   - NOTICE's debugging entry and D142 corrected.
3. **`kiln practices`:** the trigger kinds, diff size in lines, the Risk flags section in
   kiln-writing-plans and its parse, and the review gate's two refusals.
4. **REVIEW:**
   - the readers and their edits;
   - no-severity readers and triage;
   - routing, the Plan Change Log and the fix pass;
   - measured against step 0.
5. **PLAN:** planning-and-task-breakdown fields, the matrix, the conditional design files.
6. **IMPLEMENT:**
   - incremental implementation, the baseline and the TDD additions with the revert proof;
   - the debugging additions and parallel dispatch;
   - source-driven, doubt-driven, simplification, CI and browser;
   - verification-before-completion and definition of done at handover.
7. **INVESTIGATE and DEFINE:** interview-me with the brief fields, idea-refine, the spec
   excerpt, the spec kernel, the architecture adversary, context and constraints at init.
8. **SHIP:** the git-workflow excerpt; the rollback plan and GO/NO-GO in the PR body.
9. **README:** a per-stage table in the sources' shape, naming what kiln runs at each stage
   and where it came from.

Skill descriptions are not rewritten in Phase A. Changing them changes routing, so it needs its
own measurement.

# Phase B — past the sources

Each item gets its own design document and adversarial review first. The second review of this
plan listed what each one must answer.

| Item | Why it is worth doing | What its design must settle |
|---|---|---|
| **Task snapshots and `kiln restore`** (save points without commits) | Gives back what D142 took from agent-skills' save points | Put the refs under `refs/worktree/` per project path (D169). Build trees the D169 way (`hash-object --no-filters`, hooks off), or blast.mjs's `checkoutTree` way, and never capture `.kiln/`. Use one ref per checkout for submodules. Snapshot before a restore, restore only this run's files, and never after the review gate. Also parentage, pruning at ship, and projects with no fast phase. |
| **Commit guard** (the SHIP-only ruling, enforced) | D142 is prose only | Key on the session's driving work and the repository the command runs in (there is no work branch). Decide what happens to a halted work. Reuse the protected-branch WRITE_OPS list. Use `shipVerdict`'s gate mapping, including the bounded path's ordering. Cover submodules through `cwdChain`. |
| **Guard against discarding uncommitted work** | agent-skills' save-point pattern and a second session can both destroy the tree | Take the full destructive_command_guard and cc-safety-net list, including path forms. Decide whether scope is any active work in the checkout. Record exact allowed spellings for kiln's own procedures. Refine D34. |
| **Subagent-driven development as a mode** | superpowers' per-task review, and BMAD's fresh implementer | Needs snapshots first. Edits beyond commits (setup, finishing, its own final review, the implementer's commit report). Supersedes D69's drop. Measured. |
| **The verbatim request** | BMAD's intent auditor has an approved intent; kiln's paraphrase is weaker for the raw ask | kiln cannot fetch (D13). Capture through a UserPromptSubmit hook or `kiln resolve`. Secrets, since `.kiln/work/` is committed. Prompt injection (D59). |
| **Bar guard** (tests weakened, checkers silenced, stubs left) | agent-skills' floor-guard, enforced | A target for "threshold moved". Filter to this run's files. Block or report. What an unrunnable check means. A name that is not "floor". |
| **receiving-code-review on an opened pull request** | superpowers' discipline for review comments | A follow-up work opens a second pull request today; the flow for replying on the first. |
| **walkthrough** | BMAD's human-guided review | Where it sits against the review gate. |
| **Skill descriptions as trigger conditions only** | superpowers writing-skills: an agent "may follow the description instead of reading the full skill content" | Measured, since it changes routing. |

## The two reviews, and what changed

**First review** (4 blockers, 9 high, 10 medium, 8 low):

- The commit guard would have broken subagent-driven development.
- Two adopted items needed source edits after the review gate.
- BMAD's routing reverted code and looped on its own.
- Two fix mechanisms contradicted each other.
- The security reader was opt-in.
- Triggers relied on judgement.
- Severities were not reconciled.
- Copies named skills kiln lacks.
- Items were unplaced.
- The proof was thin.

All were answered in revision 1.

**Second review** (3 blockers, 14 high, about 20 medium). It found that revision 1's new
mechanisms carried new risks:

- snapshots would capture `.kiln/` and roll back gate records;
- the stash procedure would disable every guard;
- request.md would commit ticket secrets;
- the commit guard keyed on a branch kiln does not store.

It also found:

- mis-citations of D69, D162, D102 and D34;
- a fix-pass entry rule that contradicted kiln's own grading;
- copies still carrying commit and deploy steps;
- a parity proof that could not run as written.

Revision 2 answers these in three ways:

- **By separating the phases.** Phase A takes the sources' content with the least new code, so
  none of those mechanisms is in it.
- **By correcting each point that stays in Phase A:**
  - the intent auditor reads the gate-hashed Goal, as BMAD reads its approved Intent;
  - fix-pass entry uses kiln's own cells;
  - readers do not grade;
  - every misleading copy line is named or excerpted;
  - the measurement runs prompts over fixtures with a stated bar.
- **By writing each Phase B mechanism's open questions into its row** above.
