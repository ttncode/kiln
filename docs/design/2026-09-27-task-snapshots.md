# Task snapshots and `kiln restore`

> **Status: design, revised once after an adversarial review.** Phase B, item 2 of the
> skill-parity plan. The review's findings and the answers are the last section.

## The problem

agent-skills' save-point pattern: "Test passes? → Commit → Continue. Test fails? → Revert to
last commit → Investigate" (git-workflow-and-versioning, `2686b62`). kiln commits once, at
SHIP (D142, enforced by D206), and refuses the reverts (D205). So a run that breaks a passing
task halfway through its fifth has no known-good state to return to except by hand.

The second use is the stronger one. Subagent-driven development (Phase B, item 3) gives each
task's reviewer the diff of that task alone, which superpowers gets from a commit per task
(`subagent-driven-development`, `8ca22db`); kiln has no per-task commits. A snapshot per task
gives `snapshot n-1 .. snapshot n`, the same diff, without one. Claude Code's `/rewind` covers
neither: it tracks its own edit tools, not files a shell command wrote.

## What proven tools do

- **Cline checkpoints**: a commit of the workspace after each step, kept out of the user's
  history; "restore files" writes one back.
- **kiln's DNA checkpoint (D162, D169)**: a commit built from objects, written with
  `update-ref` with hooks off, one ref per project path.
- **`kiln verify`'s tree (D199)**: `checkoutTree` builds the working tree as a tree through a
  scratch index, `.kiln/` removed, one per checkout; every verify run already computes it.

## The design

**What a snapshot is.** A commit per checkout of the tree `checkoutTree` builds — the tree
`kiln verify` already computes, so a snapshot adds only `commit-tree` and `update-ref` (hooks
off, kiln's identity). `.kiln/` is never in it, so a gate record can never be rolled back.
Ignored files are never in it either (node_modules, `.env`, build output). Its parent is the
work's previous snapshot in that checkout.

**Where it lives.** `refs/kiln/snapshot/<worktree>/<project path>/<id>/task/<n>` and
`…/<id>/undo/<k>` in each checkout's own repository (a submodule's ref lands in its own
`.git/modules/…`). Not under `refs/worktree/`: measured on git 2.43, `git gc --prune=now` in a
linked worktree prunes the objects behind another worktree's `refs/worktree/` refs, because gc
does not see them. A shared namespace keyed by the worktree's gitdir name keeps D169's isolation
and keeps the objects alive. The DNA checkpoint has the same hole and moves with it (its own
decision entry).

**When one is taken.**
- Task 0, the baseline, when the plan (or probe) gate is approved and no task-0 ref exists yet —
  a re-approval after the plan changed does not overwrite it.
- Task `n`, by `kiln verify <id> --task <n>/<total>` when the run passed. A failed run takes
  none: the save point is the last state a test run passed on. The output names the snapshot,
  and says so when none could be taken (a tree kiln could not build is never skipped silently).
- With no fast phase, `kiln verify --phase fast` refuses today; the task run is then
  `--phase full --task`, and kiln-implement says so.

**Restoring.** `kiln restore <id> --to <n>` (not `--task`, which means `n/total` in verify),
allowed exactly when `sourceEditVerdict` allows a source edit for this work — so never after
the review gate, never while halted, and again after a failed post-review VERIFY reopens it:
1. It takes an undo snapshot first (`undo/<k>`, the next number), records its sha in
   `carry_over`, and prints `kiln restore <id> --to undo/<k>` as the way back.
2. The paths are the diff between the snapshot's tree and the current one, per checkout, minus
   `.kiln/`, minus `dirty_at_open` (the user's own changes, D194), minus paths another open work
   claims (D66's `claimConflicts`). A gitlink (`160000`) is skipped and named: a submodule's
   own snapshot restores its files, not its HEAD.
3. Files are written back through a scratch index — `read-tree <snapshot>` then
   `checkout-index -f -- <paths>` with `GIT_INDEX_FILE` set — so smudge filters, line endings,
   the exec bit and symlinks come back as git would write them; paths added since are removed.
4. It prints every path written or removed, then: "ignored files and external state were not
   restored — rerun install and generators".

The discard guard's message (D205) to the running work's own agent names `kiln restore` as the
way back to a task's passed state.

**Pruning.** `kiln ship --opened` and `kiln close` delete the work's refs; `kiln doctor` reports
refs whose work is finished or missing. A snapshot keeps large untracked files alive until then.

## What is not taken

- A commit per task on the work branch — agent-skills' mechanism — is D142's ruling.
- Cline's shadow repository: a second object store next to the user's; refs in the checkout's
  own repository are what D169 already proved.
- Snapshots per tool call: tasks are the unit a plan names and a test run proves.
- Nested submodules and ones added mid-work: `checkoutsUnder` reads the top `.gitmodules`
  only, as it does for review inputs (D199); named as residue.

## Tests

The snapshot excludes `.kiln/`; a failed verify takes none; the baseline is not retaken on
re-approval; a restore writes back modified, deleted and added paths — CRLF (`eol=crlf`), a
symlink and an exec-bit file included — in the root and in a submodule, skips paths another work
claims and `dirty_at_open`, skips a gitlink and says so, takes a numbered undo, and is refused
after the review gate and while halted; ship and close delete the refs; the refs survive
`git gc --prune=now` run in another worktree; hooks do not run. Cost measured on the UNIOSS3
checkout before and after.

## The review, and what changed

No blocker. High:
- `checkoutTree` stores cleaned content, so writing blobs back would corrupt CRLF, LFS and
  filtered files and flatten symlinks → restore through `read-tree` + `checkout-index`;
- `refs/worktree/` snapshots are pruned by gc in another worktree (measured) → shared
  `refs/kiln/…` keyed by worktree, and the DNA checkpoint moves too;
- "predicted ∪ changed" would revert another work's edits and miss reverted paths → the
  snapshot diff minus `.kiln/`, `dirty_at_open` and other works' claims;
- a project with no fast phase never reaches a snapshot, and fast is never "green" → full-phase
  task runs, and "passed".

Medium: the baseline retaken on re-approval; undo naming and `--task` overloading; gitlinks and
nested submodules; ignored files out of step after a restore; cost reuses verify's tree and is
measured; the motivation restated around per-task diffs (superpowers fixes forward, it does not
redo a task from its prior state); restore reuses `sourceEditVerdict`.
