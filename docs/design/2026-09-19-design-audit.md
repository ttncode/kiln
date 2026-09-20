# kiln — pre-build design audit

> Audit of `2026-09-19-kiln-architecture.md` performed before any code is written.
> Method: §6.1 (self-QA before concluding; measure, do not assert).
> External evidence: `obra/superpowers`, `addyosmani/agent-skills`, `bmad-code-org/bmad-method`
> (open + closed issues, releases), plus the Claude Code `plugin-dev/hook-development`
> reference installed on this machine. Measured 2026-09-19.
>
> **Verdict as found: not build-ready.** 7 blockers, 10 high, 14 medium. Nothing below asked for a
> redesign — every item became a decision entry or a named ceiling.
>
> **Verdict now: build-ready, with nothing parked.** See §5 for how each pass closed.
> A **fifth pass** (§7) came from the owner reading the design back from the **user's seat**:
> 2 blockers, 1 high, 5 medium → **D77–D84**, plus one more blocker (**B13 → D85**) found by
> attacking that pass's own fixes before closing it.
> A **fourth pass** on 2026-09-20 read the *sources* of the four skills the design vendors and
> re-attacked the mechanisms passes 2 and 3 introduced: 3 blockers, 1 high, 2 medium (§6),
> answered by **D69–D72** and **D76**. The three parked owner items M7, M8, M9 are decided
> (**D74**, **D73**, **D75**).

---

## 0. Review plan — three layers, general to detail

| Layer | Question | Instrument |
|---|---|---|
| **L1 — coherence** | does the document contradict itself, and is any LOCKED section carrying text a later decision deleted? | read every section against the decision log; cross-check every number and every cross-reference |
| **L2 — mechanism** | for each subsystem, can an implementer build it from what is written, and does it hold when attacked? | walk the adversary path: can the agent disarm its own guards? what happens on two concurrent runs, a symlink, an empty diff, a crashed hook? |
| **L3 — detail + external** | are the identifiers, fields, orders and strings defined; and has a validated project already reported this bug? | field-by-field read of `state.json` / `config.json` / `steps[]` / `hooks.json`; then match each subsystem against the three upstream issue trackers |

Re-measured, because §6.1 rule 2 applies to this audit too:

| Claim | Source | Result |
|---|---|---|
| node cold start 20–30 ms (D32) | `node -e 'process.exit(0)'` ×5, this machine | 0.02 · 0.02 · 0.02 · 0.03 · 0.03 s — **holds** |
| node v20.20.2 (D32) | `node --version` | **holds** |
| hook contract: `exit 2` + stderr blocks, `exit 0` allows (D32) | `plugin-dev/hook-development/SKILL.md:297` | **holds, with a third case the design misses** — see B7 |
| upstream is v6.3.0 (D4, §1.4) | GitHub releases | **stale** — v6.4.1 published 2026-09-19T00:32Z. See H6 |
| `search_code repo:obra/superpowers … → 0 results` (D13) | re-ran the search | **artifact** — 38 hits, all incidental word matches; the one real hit is `gh pr view --web` used as a command inside a plan document. D13's conclusion stands; its evidence sentence does not. See M12 |

---

## 1. Blockers — an implementer cannot start, or the safety promise is false

### B1. The agent can approve its own gates and disarm its own guards

`guard-gate` ALLOWs every write whose target is `.kiln/work/<id>/` (§3c). `state.json` lives in
`.kiln/work/<id>/` (§3g), and `state.gates[...]` is the value `guard-gate` reads. So one `Edit`
on `state.json` setting a gate to `approved` unlocks source edits. The same shape defeats
`guard-protected-branch`: it reads `.kiln/config.json` (§3c), and nothing stops an `Edit` that
empties `vcs.protected`.

This makes D7 items 1 and 4 self-defeating: the enforcement reads a file the enforced party may
write. It is not a hypothetical — an agent that hits a block routinely looks for the file that
caused it.

Direction: kiln's control files are written by kiln's code, never through `Edit`/`Write`. Both
guards BLOCK tool-writes to `.kiln/config.json` and `.kiln/work/*/state.json`; `guard-gate`'s
ALLOW covers the *artifacts* (`brief.md`, `plan.md`, …), not the state. Add as D7 test 7.

### B2. `guard-gate`'s gate key is a placeholder

§3c is literally `state.gates[<gate authorizing source edits>] == approved`. The mapping from
ceremony path to authorizing gate key is never given. Three paths, three different keys
(`spike` → probe, `bounded` → plan, `full` → plan), and the `spike` probe gate belongs to no
stage in §3e's table. Unimplementable as written; also unclear where the probe gate is emitted
in D25's todo list.

### B3. There is no resolver for `<active-id>`

`guard-sandbox` and `guard-gate` both read `work/<active-id>` (§3c, D19). Nothing defines how a
hook — a separate node process holding only stdin JSON — decides which id is active. With two
`in_progress` work dirs, or a stale one from last week, the guard cannot answer, and a guard that
cannot answer must BLOCK under D33, which bricks the session.

Measured: PreToolUse stdin carries `session_id`, `cwd`, `permission_mode`, `tool_name`,
`tool_input` (`hook-development/SKILL.md:300-320`). Binding the active work to `session_id` in
`state.json` resolves it and costs one field.

Corroboration: BMAD #2849 — *"bmad-build resume and parallel runs lack attributable per-run
state"* is this exact bug in a shipped tool.

### B4. Work-id minting is undefined for the primary entry point

§3b names the one-sentence entry as **primary**, and D24 resolves four argument shapes — but
never says what `<id>` becomes when the argument is a sentence. `work/<id>/` is the whole
identity model (D18), so this blocks P0.

Two collisions follow from the same gap: multi-repo config allows two ticket-owning modules
(§3g), so both can own issue `42`; and a sentence-entry id derived from the text can repeat.

Corroboration: superpowers #2138 — `docs/alpha/plan.md` and `docs/beta/plan.md` resolved to one
workspace and silently overwrote each other's briefs. Fixed upstream in v6.4.1 by recording the
owning plan per workspace.

### B5. A string-compared sandbox is not a sandbox

`guard-sandbox` decides inside/outside from paths (§3c, D34, D38). Three defeats, none addressed:

1. **Symlink.** A symlink created under `work/<id>/` pointing at `~/.bashrc` passes any
   path-prefix test, and the write lands outside. agent-skills #295 finding 4 is this bug, rated
   High, in a shipped hook: *"`cat > "$target"` on an untrusted `file_path` with no symlink
   check; arbitrary-file-overwrite primitive"*, with a session-long TOCTOU window.
2. **Prefix vs segment.** `p.startsWith(root)` accepts `/home/you/repo-evil` for root
   `/home/you/repo`. Compare resolved path segments, not string prefixes.
3. **Case.** macOS is a v1 platform (D9) and its default filesystem is case-insensitive, so
   `.KILN/work/…` is the same file as `.kiln/work/…` but not the same string. The same issue
   notes path normalization as a distinct finding.

Defeats D7 items 2 and 5. Fix is `realpath` + `lstat` + segment compare, and it belongs in the
D7 tests, not in prose.

### B6. The guards only see `Edit`, `Write` and `Bash`

- `NotebookEdit` is a live tool in this harness and is not in the matcher. Matchers are
  case-sensitive (`hook-development/SKILL.md:409`), and whether `Edit|Write` is an anchored list
  or a substring regex is undocumented — so whether `NotebookEdit` is covered by accident is
  currently unknown, which is not an acceptable state for a safety claim.
- An MCP filesystem write tool is not matched at all.
- In `Bash`, `sed -i`, `tee`, `python -c`, and a heredoc all edit source without touching
  `Edit`/`Write`, so **`guard-gate` is bypassable through Bash** — it is registered only on
  `Edit|Write` (§3f). D7 item 4 has the same hole D34 found for item 2.

D34 set the right precedent: extend the existing guard, or state the ceiling in a `ponytail:`
comment and in Section G's grading. What is not acceptable is leaving item 4 reading as fully
enforced.

### B7. The fail-closed law has a floor it cannot reach, and the CI invariant overstates it

Measured exit-code contract (`hook-development/SKILL.md:296-298`):

```
0  - Success
2  - Blocking error (stderr fed back to Claude)
Other - Non-blocking error
```

"Non-blocking" means **the tool runs**. So every dispatcher-level failure fails *open*: node not
on `PATH` (superpowers #2310 is exactly this — *"SessionStart hooks fail when PATH is broken:
dirname/cat/bash not found"*), a syntax error in `dispatch.mjs`, an uncaught throw exiting 1,
OOM, or the hook timing out. D33's law and its CI invariant — *"no core guard may have a failure
branch ending in ALLOW"* — cannot cover any of them, because the process never reaches a branch.

Also: `hooks.json` (§3f) sets no `timeout`, although the field exists per hook
(`references/advanced.md:18`). Without it a hung guard hangs every Edit; with it, a timeout is
most likely a non-2 exit, i.e. fail-open. That needs to be measured in the pre-P0 test, not
assumed.

Required: a top-level `try/catch` whose only exit is 2; an explicit `timeout`; a `kiln doctor`
check that node resolves; and D35's own honesty standard applied — the floor is named, not
papered over.

---

## 2. High — conflicts, and stale text inside LOCKED sections

### H1. Section A still sells a deleted concept
§3b's comparison table claims kiln has *"rounds + state, resumable"*. D18 deleted rounds. The
table is the document's headline claim and currently advertises a subsystem that does not exist.

### H2. §4 puts umami on Knowledge tier 1, which §3 defers to v1.2
Tier 1 is DNA, and DNA is deferred for the only accepted reason (an install-time dependency).
An acceptance subject cannot require a deferred tier.

### H3. §4 introduces two stacks §3 does not ship
`node-lib` (zod) and `node-prisma` (umami) appear in the subject table; §3's v1 list is
`stack-node` + `stack-php-ci3`. Prisma is schema-first with generated migrations, which is a new
**effect** under D30 — so the exam subject quietly grows v1 scope and re-opens D30's
"exercised by one adapter" note.

### H4. §4 still claims a port D13 retracted
*"UNIOSS + Jira … Proves **Tracker port**"* — D13 retracted Tracker as a code port. Related
terminology drift: §3 lists nine "adapters", of which `tracker-*`, `vcs-*` and `verify-*` are
zero lines by §3d. Calling a config value an adapter re-imports the retracted vocabulary and
costs a stranger a concept (principle 3).

### H5. "Does not duplicate their skills" vs vendoring four of them
§3b's refusal list says kiln *"does not duplicate their skills"*; §3 and §3d vendor four
superpowers skills (`brainstorming`, `subagent-driven-development`, `writing-plans`,
`executing-plans`). A user who has superpowers installed — the most likely kiln user — then has
two skills named `brainstorming`.

Corroboration: agent-skills #569 (*"still injects … on every SessionStart, which is the double
routing #557 tells users to avoid"*) and #95 (*"`/review` collides with Claude Code's bundled
`/review`"*). Either namespace the vendored copies (`kiln-brainstorming`) and say so, or depend
on upstream and delete the copies. Both are decisions; silence is not.

### H6. D4's upstream pin is stale, and v6.4.1 changes exactly the four inherited skills
v6.4.1 was published **2026-09-19T00:32Z**, after §1's measurement. From its notes:

| Change | Why it matters to kiln |
|---|---|
| `executing-plans` *"was a 64-line stub that measured the same as running with no plugin at all"* → rebuilt as Native execution | porting the v6.3.0 copy ports a version measured as worthless |
| *"You review the saved plan before anything runs. Approving an idea or a scope no longer counts as approving a plan you haven't seen"* (#2258) | validates kiln's plan gate; adopt the wording |
| Plans carry a **Review Focus** section — up to five spec-implied inputs no task tests (#2319); *"in evals, every implementer shipped the same crash on an input the spec implied but never named"* | `plan.md` has no equivalent; this is a measured failure mode, cheap to adopt |
| Reviewers judge unspecified behavior by reasonable-user expectation, plus a **"Declined to judge"** list (#2319) | `review.md` has neither |
| TDD: *"the project's suite defines green, not just your test file"* — sessions ran only the named file in 11 of 12 probe runs | kiln's `phase: fast` is "only what the change touched"; the rule must be that a fast pass is never reported as green |
| SDD workspace-collision fix (#2138) | see B4 |
| `review-package` rejects empty or non-descendant `BASE..HEAD` with exit 3 (#2136) | see H7 |
| *"Skills work when a packager strips executable bits"* — invoke bundled scripts through their interpreter (#2301) | kiln already invokes `node "…"`; the vendored `start-server.sh` / `stop-server.sh` (D11) must be invoked as `bash …` |
| `git merge-base origin/main HEAD` replaces bare `origin/main`, which *"showed main's newer files as phantom deletions once main moved past the branch point"* (#2133) | kiln already uses three-dot `<base>...HEAD`, which is merge-base semantics — **already covered** |

Re-pin D4 to v6.4.1 and re-read the four skills before porting.

### H7. An empty or wrong-branch diff yields a clean review of nothing
D31 makes predicted-vs-actual *report and never block*. If the implementer committed to the
wrong branch, `actual` is 0 files and REVIEW proceeds over nothing, then VERIFY passes, then SHIP
opens an empty PR. Upstream hardened exactly this into a refusal (#2136, exit 3). One halt is
enough: `actual == 0` stops the run. This is a different case from "discovery during
implementation", which is why D31's rejection of blocking does not cover it.

### H8. `state.verify[]` has no freshness anchor
The record is `{id, cmd, exit, ms}` — a duration, not a time, and no commit. So a green run
followed by more edits is still reportable as "12/12, all exit 0", and §3h's audit check 3
(reconcile `verify[]` against the report text) cannot detect it. That is D7 item 3's exact shape
surviving inside its own evidence store.

Corroboration: superpowers #2286 — *"verification-before-completion: the skill requires fresh
evidence but never asks where the evidence came from"*. Add `at` and the `HEAD` sha per entry;
entries older than the last source write are stale, not evidence.

### H9. Resume has no step to resume from, and `halted` has no resume path
D24 says `in_progress` *"resumes at the stopped step"*, but `state.json` (§3g) carries
`status · gates · predicted[] · verify[] · pass · carry_over[]` — no current stage, no in-flight
step. And `halted` (§3c) is a real status that D24's resolution order never branches on.

Corroboration: superpowers #2293 — *"the ledger records no in-flight task, so an outage mid-task
re-dispatches work that is already committed"*; #2253 and #2267 — deferred findings and
cross-task discoveries lost at finish, which is what `carry_over[]` exists to prevent and should
therefore be defined, not just named.

### H10. Untrusted input is not modeled, and D7 item 6's scope is ambiguous
Ticket bodies, PR comments and fetched pages are attacker-controllable text that lands in
INVESTIGATE — and §4's exam subject was chosen *because* its issues are rich prose, including
#4526 which proposes its own fix. Nothing in the document treats that text as untrusted.

Related: D7 item 6 promises kiln *"never sends anything to the network outside the declared
tracker/VCS"*, while D35's proof is a static grep of kiln's own source. The grep says nothing
about the agent following a URL a ticket asked it to fetch. Either narrow item 6 to "kiln's own
code performs no egress" — which is what is actually provable — or add a real control.

Corroboration: agent-skills #295 finding 1, rated Critical: SSRF because a hook followed
redirects on a URL that arrived from tool input.

---

## 3. Medium — will bite between P0 and P2

| # | Item |
|---|---|
| M1 | `${cmd.*}` interpolation: behavior on a missing key is undefined (D40 explicitly rejected "skip when the script does not exist", so this needs its own answer), and whether `run` executes through a shell or as argv is undecided — that decides quoting and whether config text reaches a shell |
| M2 | `branch_pattern` default is `${type}/${id}-${slug}`; neither `${type}` nor `${slug}` is defined anywhere |
| M3 | `kiln init` behavior when `.kiln/` already exists is unspecified. BMAD #2879: *"bmad setup fails on Windows when `_bmad/` already exists"* |
| M4 | Greenfield / non-git directory: blast radius, reconciliation, the reflog audit and SHIP all assume a git repo. superpowers #2242: *"SDD scripts crash on greenfield Task 1 — no git repo yet"* |
| M5 | `JSON.parse` throws on a UTF-8 BOM, so a BOM'd `config.json` reads as "config broken". BMAD #2725: BOM'd files silently dropped, CRLF files rewritten wholesale |
| M6 | What the SHIP commit stages is unspecified. "Swept up by the SHIP commit" must not mean `git add -A`, which would commit unrelated working-tree files |
| M7 | `tmp/<id>/` is deleted at the end of SHIP (Superseded), which destroys the step logs the PR body's evidence refers to |
| M8 | `verify.provider` overlaps `stack.steps[]`: one is skill text, one is code, both mean "run checks". A playwright run is a step. Deleting the `verify` port removes a port, a config key and two "adapters" — a stranger stops having to learn which of two mechanisms runs their tests |
| M9 | Review findings have severity but no likelihood axis, and no rule against a finding quota. agent-skills #436: *"findings ranked by consequence only … improbable findings block merges"*; BMAD #2772: *"one review layer's quota manufactures findings"* |
| M10 | §3b calls the bounded run "seven beats" over a list of eight items, and the list omits VERIFY, which §3e says `bounded` runs |
| M11 | §3's Deferred section says *"Both remaining deferrals exist for one reason"* above a three-row table whose other two rows add no dependency |
| M12 | D13's evidence sentence (*"→ 0 results"*) is a fuzzy-search artifact; re-running it returns 38 incidental matches and one real one (`gh pr view --web`, a command in a plan doc). The conclusion — no tracker client code anywhere — holds; restate the evidence as that |
| M13 | kiln renames superpowers' `architectural` path to `full` with no decision entry (rule 5) |
| M14 | The plugin `hooks.json` shape is unverified: the installed reference shows plugin hooks both wrapped in `{"hooks": {…}}` and unwrapped at top level. Wrong shape means silent non-registration — agent-skills #445: commands *"don't appear as searchable commands, despite `plugin validate` reporting them as processed"*. The pre-P0 test must assert an actual block, never that the file parses |

---

## 4. Already covered — problems a validated project hit and kiln does not

Recorded so they are not re-litigated, and so the coverage is not accidentally removed later.

| Upstream problem | Why kiln is immune |
|---|---|
| superpowers #2133 — bare `origin/main` shows phantom deletions after main moves | kiln compares `<base>...HEAD` (three-dot = merge-base) and pins to `origin/<integration_branch>` (D22) |
| BMAD #2823 / #2879 — scripts want to own `.venv`; installer needs Python | zero dependency, Node only (D2), with BMAD's `uv` halt cited as the precedent |
| agent-skills #475 / #488, superpowers #2310 / #2105 / #1480 / #569 — the whole SessionStart failure class | kiln registers no `SessionStart` (D32) |
| superpowers #2301 — packagers strip the executable bit | hooks invoke `node "…"`, never the script directly |
| agent-skills #440, BMAD #2907 / #2607 — version metadata disagrees across manifests | version-sync is a conformance test (D17) |
| BMAD #2886 — *"Code Map cannot say which files a story writes and which it must not touch"* | `state.predicted[]` plus reconciliation (D31) |
| agent-skills #295 finding 5 — non-atomic rewrite loses the file and the backup | atomic state writes, tmp + rename (§3c) |
| superpowers-wide — stdout parsed for a pass verdict | exit code only, stdout never parsed (D29), and it is D7 test 3 |

---

## 5. What "build-ready" needs

**Status 2026-09-20 — closed, in three passes.** The `verdict` at the head of this file records the
audit as it was found; the architecture file records what was decided.

| Pass | What it did |
|---|---|
| 1 — audit | B1–B7 and H6–H10 → **D48–D62**; H1–H5 corrected in place; M1–M6 → **D60**; each with a Superseded entry naming what was wrong |
| 2 — pre-P0 hook test | ran and **passed**; ten further measured answers → §1.6 of the architecture file; closed **Q5**, **Q6**, **M14** → **D63–D64** |
| 3 — source review | read what superpowers and BMAD actually shipped → **D65–D68**, which answered the blocker that pass 1's own fix had exposed (no writer for `state.json`), replaced D50's broken mechanism, promoted **M6** to a law, corrected **D57**, and closed **M13** |
| 5 — user-seat read-back | the owner read an inverted, user-perspective description of the design and questioned it → **D77–D84** (§7). Two of the findings had survived four builder-seat passes |
| 4 — pre-build design review | read the **v6.4.1 sources** of the four vendored skills and re-attacked passes 2–3's own mechanisms → **B8–B10, H11, M15–M16** (§6) → **D69–D72, D76**; closed the three parked owner items → **D73–D75** |

Three findings from pass 2 and 3 are worth keeping in view because they are corrections to *this
audit*, not to the design: D50 was a hole I introduced while fixing B3; D57's timestamp was the
wrong anchor and BMAD's production numbers gave the right one; and the tempting fix for B8 —
`state.json` under `.git/` — was rejected by measurement (§1.6 row 10).

**Nothing remains parked.** The three owner items were decided on 2026-09-20:

| # | Parked question | Ruling |
|---|---|---|
| M7 | `tmp/<id>/` is deleted at the end of SHIP, destroying the step logs the PR body cites | **D74** — settled from the other side: log content does not go into a pull or merge request on the remote at all. The PR body cites `state.verify[]` rows, which are committed; `tmp/` is still deleted at the end of SHIP; no retention mechanism is added |
| M8 | `verify.provider` overlaps `stack.steps[]` — one skill text, one code, both meaning "run checks" | **D73** — cut `verify`. A Playwright run is a step. Removes a port, a config key, three provider values and §4's Verify column |
| M9 | review findings have severity but no likelihood axis, and no rule against a finding quota | **D75** — adopt both: the likelihood axis (agent-skills #436) and a ban on any minimum-finding count (BMAD #2772) |


1. B1–B7 answered as decision entries D48+ (six of the seven are one field or one guard change;
   B7 is a ceiling to name, not a bug to fix).
2. H1–H5 corrected in place — they are stale text in LOCKED sections, so the correction is
   mechanical once approved.
3. H6: re-pin to v6.4.1 and re-read the four inherited skills; H7–H10 are one field, one halt,
   one wording narrowing, and one status branch.
4. M-list triaged: M1–M6 before P0 code (they are unspecified behavior in P0's own surface),
   M7–M14 before their owning phase. All of M7–M16 are now decided; see §6.
5. Pre-P0 hook test extended to answer what this audit could not settle from documentation:
   does `Edit|Write` match `NotebookEdit`; does a timeout block or allow; does a non-2 exit
   allow; does the `hooks.json` shape actually register.

---

## 6. Fourth pass — pre-build design review (2026-09-20)

Same three layers as §0. What was new: L3 read the **sources** of the four skills §3 vendors, at
the v6.4.1 tag D55 pins, instead of its release notes — and L2 attacked the mechanisms passes 2
and 3 had themselves introduced, on the standing assumption that a fix written in one pass is
unreviewed code.

| # | Severity | Finding | Answer |
|---|---|---|---|
| **B8** | blocker | The four vendored skills do not close. `executing-plans` v6.4.1 hard-requires `using-git-worktrees` (Setup — the worktree **D66 forbids**), `test-driven-development` and `verification-before-completion` as **REQUIRED SUB-SKILL**, `systematic-debugging`, `requesting-code-review` (also by the relative path `../requesting-code-review/code-reviewer.md`), and `finishing-a-development-branch` (Finish — which duplicates SHIP); and it resolves its workspace through `../subagent-driven-development/scripts/sdd-workspace` into `.superpowers/sdd/<plan-basename>/progress.md` — a **second identity model and second state store** beside `state.json`, which is the subsystem D18 deleted. `writing-plans` names two of them as REQUIRED SUB-SKILL inside the plan header it emits. | **D69** |
| **B9** | blocker | D66 superseded D50's `session_id` gate, leaving `guard-gate` with **no resolver at all** — ownership cannot say *whose gate record applies*, and a path discovered during implementation is in no `predicted[]` by design (D31). Separately, the ownership question reads every `in_progress` work's state, while D32 budgeted "one small `state.json` read". | **D70** |
| **B10** | blocker | D65 states kiln has "no state-setting verb at all", which leaves `gates.<key>` — the field D7 item 4 rests on — with **no writer**. | **D71** |
| **H11** | high | D66 checks an overlapping claim at **write** time, where two overlapping claims block each other: a deadlock with two error messages, not the "clear conflict" BMAD #2849 specifies. Reasoned, not measured — no upstream issue reports this shape (§6.1 rule 2). | **D72** |
| **M15** | medium | `last_verified` (D67a) has no initial value and no update point. | **D76** |
| **M16** | medium | D62's `kiln-*` rename means editing vendored bodies, which is exactly the merge-conflict cost D26 refuses. | folded into **D69** — a fork has no next merge, so the cost disappears |

External corroboration for B8's class, all in shipped code:

| Repo | Issue | State | Finding |
|---|---|---|---|
| agent-skills | **#361** | closed | `npx` packed only `skills/`, so a skill's `references/definition-of-done.md` was simply absent |
| agent-skills | **#136** | closed | "SKILL.md files reference non-existent scripts" |
| agent-skills | **#67** | closed | a harness did not read the sub-skills a skill named inside one of its phases |

The one number this pass re-measured: `obra/superpowers` latest release is **v6.4.1**, published
2026-09-19T00:32Z. D55's pin is current; D69 converts it from a pin into a fork point.

---

## 7. Fifth pass — the owner reads the design back as a user (2026-09-20)

Method, and why it found what four builder-seat passes had not: the design was **inverted** into a
description written from the user's chair — what they install, type, see, and are told when it
breaks — and then questioned as a user would question a product. A builder reads a section to
check that it is consistent. A user reads it to check that it *does the thing*, and that is a
different instrument. Two of the eight findings below are holes §0's three layers walked past four
times, because both read as settled prose.

| # | Severity | Finding | Answer |
|---|---|---|---|
| **B11** | blocker | §3c asserts *"ship is blocked separately (D12)"* with **no mechanism** — `spike` merely lacks a SHIP stage, and nothing stops the agent running `gh pr create`. Checking it found the bigger hole: on `full`, the **`ship` gate was prompt-only too**, so a PR could be opened before gate 4 — the weakness kiln exists to fix, inside kiln's heaviest path | **D77** |
| **B12** | blocker | `manifest.source_pins` is a **map keyed by repo**; `vcs.integration_branch` is a **single scalar**. On UNIOSS's four-module checkout, D22's drift check and the pin rule are correct for at most one module and silently wrong for the rest | **D81** |
| **H12** | high | The drift check compares against `origin/<integration_branch>`, a **local ref**, with no stated fetch. A ref two weeks stale reports *no drift* for a branch that moved by hundreds of files — D7 item 3's shape, inside the instrument whose job is to say how much the user does not know | **D82** |
| **M17** | medium | D12's one-way ratchet never said what becomes of `spike`'s throwaway source. SHIP is the only commit point (D36), so it is **uncommitted** — discarding it is D7 item 2, carrying it forward launders pre-plan code past D65 | **D78** |
| **M18** | medium | D22 fixed which branch the drift comparison **reads**, never which branch the **scan** is pinned to — leaving the anchor the comparison stands on undefined | **D80** |
| **M19** | medium | Two real user capabilities existed in the source to be vendored — a local explorer and a single-file export — with **no home** in the command surface, and no way for a stranger to discover them | **D79** |
| **M20** | medium | D7 item 6's proof is a **Node** grep; the ~7,500 Python lines arriving at v1.2 are not looked at. `serve_store.py` binds a loopback listener, which is legitimate — but an allowlist that never mentions Python does not permit it, it fails to look | **D83** |
| **M21** | medium | `export_static_explorer.py` reads **`explorer-v2.html`**; `assets/` ships **`explorer.html`**. One is wrong today, and the failure would surface as a stranger's export producing nothing, at v1.2 | **D84** |

One decision was **reversed inside this pass before it was written**: "refresh and view DNA are
skill text, not commands" applied D13 on the wrong axis — D13 decides whether something must be
*code*, not whether it deserves a *command*. D6 decides that, and a stranger cannot discover skill
text. Recorded in Superseded, per §6.1 rule 5.

Numbers re-measured for this pass, from the source that will be vendored at v1.2:

| Claim | Command | Result |
|---|---|---|
| a local DNA explorer exists | `ls assets/` | `explorer.html` **117 KB**, `laneflow.js` **81 KB**, `View DNA Report.bat` 555 B |
| it can be served locally | `serve_store.py` | **95 lines**; `ThreadingHTTPServer(("127.0.0.1", port), …)` + `webbrowser.open` |
| it can be exported as one file | `export_static_explorer.py` | **164 lines**; reads `explorer-v2.html` — **mismatch**, see M21 |
| a watch/poller exists to inherit | `_incubator/tps-dna-watch/SKILL.md` | **RETIRED 2026-08-24** by owner ruling — no watch, no poller, no trigger label. Matches D13 |

### 7.1 Closing attack on the fifth pass's own fixes

§6.1 rule 9 treats a fix written in one pass as unreviewed code, so D77–D84 were attacked before
the pass was closed. One finding, in under two minutes, in the newest decision:

| # | Severity | Finding | Answer |
|---|---|---|---|
| **B13** | blocker | Nothing in eighty-four entries said what becomes of `gates` when `pass` increments. Pass 2 would open with pass 1's gates still `approved`: `guard-gate` permits source edits before pass 2 has a plan (D7 item 4), and D77's `SHIP_AUTHORIZING[bounded] = "review"` permits a PR nothing reviewed. `artifact_sha` does **not** cover it — the hash catches a *changed* artifact, while here the artifact is **unchanged and that is the failure** | **D85** |

Recorded as the pass's own evidence: **five of this design's findings were created by a previous
pass's fix** — D50 (introduced fixing B3, killed by D66), D57's timestamp anchor (corrected by
D67a), D59's narrowing (made false by D82), the dispatch diagram (stale since D64), and now D77
(holed by B13). That rate is the honest input to any claim that the next pass will find nothing.
