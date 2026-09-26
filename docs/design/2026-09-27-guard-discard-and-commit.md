# Guarding uncommitted work, and the one commit at SHIP

> **Status: built** as D203 (`kiln close`), D204 (clean and stash), D205 (the discard guard) and
> D206 (the commit guard). Designed, then revised twice after adversarial reviews. Phase B, item 1 of the
> skill-parity plan. The reviews' findings and the answers are the last section.

## The problem

kiln leaves a work's change uncommitted until SHIP (D142), so everything the agent built lives
only in the working tree — and on a feature branch kiln blocks none of the commands that throw a
working tree away. Measured through the real hook with a work open: `reset --hard`, `checkout
-- <path>`, `checkout <file>`, `restore <path>`, `switch --discard-changes`, `clean -f` inside
the project, `stash drop`, `read-tree --reset -u` are all allowed. D7 says kiln "never destroys
data unasked"; D34 scoped that to targets outside the repository. D142 is prose too: `git
commit` mid-run is allowed on a feature branch.

## What the proven tools do

destructive_command_guard `5ed0250` and cc-safety-net `bbade36` both refuse `reset --hard` /
`--merge`, `checkout -- <path>`, `checkout <ref> -- <path>`, `checkout -f`, `checkout .`,
`switch --discard-changes` / `-f`, `restore` touching the worktree (`--staged` alone allowed),
forced `clean` (dry run allowed), `stash drop` / `clear`, `rm -f` without `--cached`. cc-safety-net
also refuses `checkout <existing file>`, `checkout <ref> <path>` (two operands),
`--pathspec-from-file`, `restore --patch`, `worktree remove --force`, `merge` / `rebase
--abort`; dcg also refuses `read-tree --reset/-m -u`, `update-ref -d`, `filter-branch`, `reflog
expire`, `git show REF:p > p`. Neither blocks `git commit`. Neither conditions on a dirty tree;
each relaxes in one place (dcg during a rebase, cc-safety-net in a linked worktree).

## The order of work

Each step is its own decision and pull request.

### 1. A work can end: `kiln close`

Today nothing ends a work but `kiln ship --opened`: a spike never can, the orchestrator's "close
this work and open a spike" has no verb, and `.kiln/work/<id>` is a control file the agent may
not remove. Any guard scoped to "a work is open" would then stay armed forever after a spike or
an abandoned work. `kiln close <id> --answer "<the user's words>"` sets status `closed`, records
the words as a gate answer is recorded, and releases the work's claims — the user's words,
because closing disarms the discard guard and the agent must not be able to do that on its own.
A closed work is never reopened: `resumeAction` (`lib/resolve.mjs`) and `shippedRefusal`
(`bin/kiln.mjs`) refuse it as they refuse `shipped`, and a follow-up is `--follows`. `kiln list`
shows it, and `kiln doctor` lists every work still arming the guard, with its age and the close
command for the user to run — works left `in_progress`, `reviewed` or `halted` by earlier
releases would otherwise arm it forever after the upgrade. The orchestrator offers close where a
spike's findings are delivered and where the user abandons a work. Precedent: every issue tracker
and BMAD's ticket states have a terminal state other than "done".

### 2. `git stash -u` / `-a` may not take kiln's files

Stashing untracked files takes `.kiln/work/` and, before init's files are committed (D194), the
config and hooks too — every guard is then off. That is a control-file removal, so it belongs in
the always-on removal guard, not in the discard guard: `stash` with `-u`, `-a`,
`--include-untracked`, `--all` (clusters and `save` included) is refused when its pathspec
reaches a control anchor that is untracked (or ignored, for `-a`) — once init's files are
committed, a plain `git stash -u` passes. A forced `git clean` that reaches `.kiln/` is refused
by the same guard, work open or not: today `rm -rf .kiln/hooks` is refused on a fresh init but
`git clean -fd` is allowed. The ratchet menu (D78) prints the spelling that passes — `git stash
push -u -- . ':(exclude).kiln'` plus one exclude per `dirty_at_open` path, as it does now (D194)
— and a test runs the printed string through the hook, so kiln never offers a step it refuses.
In a project with submodules the menu says the stash leaves submodule changes in place and
prints one `git -C <module> stash push -u` per changed module (verified on git 2.43: the
superproject's stash does not recurse).

### 3. The discard guard

**Scope:** while any work in this kiln root is in the `DRIVING` set (`lib/guards/context.mjs`:
`in_progress`, `reviewed`, `halted`), any session's. The data is the work's; a second session's
`git checkout .` destroys it as surely. The precedent is D66's claim check, which judges every
session's writes against every open work (its set, `activeWorks`, is narrower: `reviewed` is
left out because source is closed then; here it counts, since a reviewed change is the one most
worth keeping). Not D33, which is about sessions kiln does not drive. "This kiln root" is the
root `drivenRoot` resolves; a command reaching a submodule of it (`git -C AdminPage …`, `cd
AdminPage && …`) counts.

**Verbs:** the union of the two tools where the verb throws away uncommitted work, each taken
because it does:
- `reset --hard` / `--merge` (and `merge`, `rebase`, `cherry-pick`, `revert`, `am` with `--abort`,
  which run `reset --merge`);
- `checkout` with `--`, with `-f`, with `.`, with an operand that is an existing path and names
  no ref (git reads a branch first: `git checkout docs` with a branch `docs` and a directory
  `docs/` switches branch and keeps the change), with two operands, or with
  `--pathspec-from-file`; `-b` / `-B` / `--orphan` take a value, so `checkout -b x origin/main`
  is not two operands; `switch --discard-changes` / `-f`;
- `restore` whose target includes the worktree, `--patch` included;
- `clean` forced and not dry-run;
- `stash drop` / `clear`;
- `mv -f` onto an existing path (verified: it overwrote a dirty target);
- `read-tree` with `-u` and `--reset` or `-m`; `worktree remove --force` on a worktree inside
  the kiln root (the review skill's throwaway `/tmp/review-<sha>` worktree stays removable);
- `submodule deinit -f`, `submodule update --force` — the change can live in a submodule;
- `git show <rev>:<path> > <path>` (a redirect overwriting the path it shows).

`rm -f` of a tracked file is a deletion the agent may plan, not a discard: it is gated as a
source edit while source is closed, as shell `rm` is, and passes while source is open.
Long-option prefixes and short clusters are read as git reads them; values of options that take
one are skipped, so `-e -n` is not a dry run (D201). Parsing goes through D200's
`gitInvocation`, extended to dashed binaries (`git-checkout`), and the guard sits in the
pre-bash chain so `bash -c`, heredocs and `!` aliases are judged too.

**Not in this guard:** `branch -D`, `push --force`, `+ref`. They cannot touch the uncommitted
tree, the protected-branch guard already refuses them onto protected branches, and refusing them
everywhere while a work is open would block routine cleanup in unrelated sessions.

**Allowed:** `restore --staged`, `checkout -b`, `switch <branch>` (git refuses to switch over
conflicting changes itself), `stash push` / `pop` / `apply`, `reset --soft` / mixed / `--keep`,
`clean -n`, bisect over commits.

**The message** depends on the work's state, and never suggests a retry: while source is open,
"write the file back by edit"; after the review gate or while halted, "only the user can discard
it, in their own terminal — kiln will not run it". It names the work that arms it and never
offers `kiln close`: that is the user's call. It does not run `git status` (on a
superproject with submodules that can outlast the hook's timeout).

### 4. The commit guard

**Rule:** `git commit` in any form is refused while this session drives a work whose
ship-authorising gate is not approved (`shipVerdict`), and for a displaced session. At SHIP it
also refuses `commit -a` / `--all` / `--include` / a commit naming paths, since SHIP commits the
explicit path list `kiln ship` prints (D67c); `git add -A` is refused already.

**Scope:** this session's work only. The discard guard protects the tree from every session; a
second session's commit of its own work is D66's claim check's business.

**Order at SHIP:** on `bounded` the review gate authorises shipping and comes before VERIFY, so
the guard cannot tell a commit before VERIFY from one after it; VERIFY-before-commit stays
prose, as D142 words it and as `kiln ship` already reports an unverified ship. On `full` the
`ship` gate authorises it, and the orchestrator renders that gate once D202 lands — which it
does before this step starts.

## Accepted residue

Named, as D34 and D98 name theirs: aliases defined in git config files or through
`GIT_CONFIG_*` (a command-line alias is expanded, D200); `xargs` / `find -exec` / `parallel`
running git; `git submodule foreach`, `rebase -x`, `bisect run` with a git command inside; `git
apply -R`; `checkout-index -f`; shell `rm` / `mv` / `cp` over tracked files (gated as edits
while source is closed, not as discards); scripts the project's steps run; programs in an inline
interpreter beyond D98 / D129; `commit-tree` + `update-ref`.

## Tests

Corpus rows for every verb and spelling above, deny with a work open and allow with none, and
the allowed forms; wrapper, alias, `bash -c`, heredoc, `-C sub`, `cd sub &&` spellings; a second
session; a closed work that no longer arms anything; the ratchet menu's printed stash; the
commit rule on spike, bounded and full before and after the authorising gate, displaced, and
halted. The fixture gains review- and ship-gate variants. One e2e run through SHIP on each path.

## The review, and what changed

The first version was reviewed against kiln's code and both tools. Blockers:
- a work that never ends would arm the guard forever → `kiln close` first;
- the ratchet menu offered a stash the design refused → the menu changes with the rule;
- the commit guard would have refused every `full` SHIP, because nothing told the agent to record
  the `ship` gate → fixed on its own as D202.

High findings:
- taking the tools' intersection dropped `checkout <file>` and other real discards → union, each
  judged;
- "cannot be routed around" overclaimed → residue named;
- `git status` in the message could time the hook out → removed;
- the stash rule was in the wrong guard → moved to control-file removal;
- decision entries were not named → one per step.

Medium findings:
- the scope wording, and D66 rather than D33 as its precedent;
- displaced sessions, `commit -a`, and the bounded ordering;
- `branch -D` and force-push dropped from this guard;
- prefixes, clusters and the `-e -n` case (fixed on its own as D201);
- chain order.

The second review checked every cited decision and function against the code. It found no
blocker, and it verified on git 2.43 the stash spelling, `reset --keep`, `stash pop` on a
conflict and `switch <branch>` as allowed, and `reset --merge` as a discard. What it found, and
what changed:
- the agent could disarm the guard with `kiln close` → close takes the user's words, and the
  message never offers it;
- works left open by earlier releases would arm the guard forever → `kiln doctor` lists them;
- `closed` was not refused by `open` / resume → both refuse it;
- `git clean -fd` removed kiln's untracked files on a fresh init → refused by the removal guard;
- the stash spelling dropped D194's `dirty_at_open` excludes and did not recurse into submodules
  → both kept or printed;
- a plain `git stash -u` would be refused after setup is committed → only an untracked anchor;
- `checkout <branch>` named like a directory, and `-b <name> <start>` → ref first, values skipped;
- `mv -f`, `submodule deinit -f` / `update --force` were missing → added;
- `worktree remove --force` would block the review skill's throwaway worktree → kiln root only;
- `rm -f` of an edited file is a deletion, not a discard → gated as an edit;
- D202 was cited before it existed, and the D66 set was overstated → both corrected.
