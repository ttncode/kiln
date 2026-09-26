# Guarding uncommitted work, and the one commit at SHIP

> **Status: design, before review.** Phase B, item 1 of the skill-parity plan
> (`2026-09-26-skill-parity.md`). No code until an adversarial review has read this.

## The problem

kiln leaves a work's change uncommitted until SHIP (D142). Everything the agent has built lives
only in the working tree — and on a feature branch kiln blocks none of the commands that throw a
working tree away. Measured through kiln's real hook on `feature/work`, with a work open, all of
these are allowed: `reset --hard`, `reset --merge`, `checkout -- <path>`, `checkout <ref> --
<path>`, `checkout -f`, `restore <path>`, `restore --source=…`, `switch --discard-changes`,
`clean -f` inside the project, `stash drop`, `stash clear`, `branch -D`, `push --force`,
`rm -f`, `read-tree --reset -u`. D7 promises kiln "never destroys data unasked"; D34 scoped
that to targets outside the repository, and inside it the promise is prose.

The copied sources make this sharper: agent-skills' git-workflow teaches a "save point" pattern
(`git reset --hard HEAD` to go back) that on kiln's uncommitted tree destroys the work. kiln
declined that section, but nothing stops an agent reaching for it.

D142 itself is prose too: `git commit` mid-run is allowed on a feature branch (corpus row
"git commit -m x" → allow).

## What the proven tools do

Read at destructive_command_guard `5ed0250` and cc-safety-net `bbade36`.

| Verb | dcg (default pack) | cc-safety-net |
|---|---|---|
| `reset --hard`, `reset --merge` | deny | deny |
| `reset --keep`, `--soft`, mixed | allow | allow |
| `checkout -- <path>`, `checkout <ref> -- <path>`, `checkout -f` | deny | deny |
| `checkout .` | deny | deny (pathspec-shaped) |
| `checkout <existing file>` | allow | deny |
| `checkout -b / --orphan` | allow | allow |
| `switch --discard-changes / -f` | deny | deny |
| `restore <path>` (worktree) | deny | deny |
| `restore --staged` alone | allow | allow |
| `clean -f` (any order) | deny; a cluster with `n` allows | deny; only an exact `-n` / `--dry-run` allows |
| `stash drop`, `stash clear` | deny | deny |
| `stash pop / apply` | allow | allow |
| `branch -D` | deny (and `-d`) | deny (`-D`, or `-d` with force) |
| `push --force / -f / +ref` | deny (`--force-with-lease` allowed) | deny |
| `rm -f` without `--cached` | deny | deny |
| `read-tree --reset -u`, `update-ref -d`, `filter-branch`, `reflog expire` | deny | not covered |
| `commit` | not covered | not covered |

Neither conditions a rule on a dirty tree. Each relaxes in one place where discarding is
normal: dcg while a rebase is in progress; cc-safety-net inside a verified linked worktree.

## Design

### 1. The discard guard

**Scope:** while a work is open in this checkout — any session's, not only this one's. The data
at risk is the work's, and a second session running `git checkout .` destroys it as surely as
the driving one. With no work open, kiln does not police the session (D33); the harness's own
permission prompt is the user's guard.

**Verbs:** the intersection of the two tools, which both have run in production:
`reset --hard`, `reset --merge`; `checkout -- …`, `checkout <ref> -- …`, `checkout -f`,
`checkout .`; `switch --discard-changes`, `switch -f`; `restore` whose target includes the
worktree; `clean` forced and not dry-run (cc-safety-net's reading, the stricter one); `stash
drop`, `stash clear`; `branch -D`; `push --force` / `-f` / `+ref` (kiln already denies these to
a protected branch); `rm -f` without `--cached`. Parsing goes through D200's `gitInvocation`,
so wrappers and aliases cannot route around it.

**Allowed, deliberately:** `restore --staged`, `checkout -b`, `switch <branch>` (git itself
refuses to switch over conflicting local changes), `stash push` / `pop` / `apply`, `reset
--soft` / mixed / `--keep`, `clean -n`. `stash -u` stays allowed only with a pathspec that
excludes `.kiln` — the second review of the skill-parity plan showed that stashing untracked
files takes `.kiln/work/` with them and turns every guard off.

**The message** names the command, says what it would throw away (from `git status --short`
for the paths it touches), and gives the ways that remain: `kiln halt` and ask the user, or —
for a file the agent itself wants back — rewrite it by edit.

### 2. The commit guard

**Rule:** `git commit` (any form, D200's parsing) is refused while this session's work is open
and its ship-authorising gate is not approved (`shipVerdict` already knows which gate that is on
each path). After that gate, SHIP commits exactly as today.

**Why a guard and not prose:** D142 has been prose since it was decided; three of the practice
files kiln copied (incremental-implementation, git-workflow, code-simplification) had "commit"
in numbered steps until kiln edited them, and a future copy may carry one again.

**Scope:** the session's own work only — a user committing their own changes in another
terminal is not kiln's business (D33). A halted work still counts as open.

## What this does not do

- It does not snapshot the tree (Phase B item 2), so a discard the user asks for is still final.
- It does not read `git` run inside an inline program beyond what D98/D129 already refuse.
- It does not relax in a linked worktree or during a rebase; kiln has no reason to discard a
  work's tree in either.

## Tests

Corpus rows for every verb and spelling above (deny with a work open, allow with none), the
allowed forms, wrapper and alias spellings, a second session's discard, and the commit rule on
each path before and after its ship-authorising gate.
