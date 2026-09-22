# The rules router, measured on ten checkouts — 2026-09-23

Fixtures answer *does the mechanism work*. A checkout somebody else laid out answers *does
it work here*, and every defect this project has found came from the second question. The
owner's instruction before this pass was explicit: fork or build real sources, test the
combinations, because the test plan is the only thing standing between a defect and a user.

`scripts/acceptance-journey.mjs` already ran a real repository end to end. This pass added
the router's own rows to it and ran it across a matrix rather than a list.

## The matrix

Six real repositories, cloned shallow, `origin` removed before anything else runs:

| Checkout | What it contributes |
|---|---|
| `sindresorhus/slugify` | the plain case — one package, no TypeScript, no workspace |
| `colinhacks/zod` | pnpm workspace; **`README.md` is a symlink into `packages/`** |
| `expressjs/express` | old conventions, and a README spelled `Readme.md` |
| `typicode/husky` | the project that invented the `core.hooksPath` problem |
| `pallets/flask` | Python — no manifest kiln reads, so the unknown-stack path |
| `bcit-ci/CodeIgniter` | PHP, `composer.json`, the `php-ci3` stack |

Four layouts built from those clones, because a layout is not a repository:

| Layout | Built from | What it contributes |
|---|---|---|
| `husky-path` | slugify + `core.hooksPath=.husky` | hooks read from somewhere other than `.git/hooks` |
| `worktree-linked` | express + `git worktree add` | `.git` is a file; hooks live in the common dir |
| `super` | a superproject with slugify as a submodule | detection and the floor across two checkouts |
| `deep` | a superproject whose submodule has a submodule | the two-deep walk |

**Result: ten checkouts, every row green.** Two defects were found and fixed on the way, and
one harness assumption was wrong in a way that had been hiding a real question.

## Finding 1 — a deliberate refusal reported as a bug in kiln

zod's `README.md` is a symlink into `packages/zod/`. kiln refuses to follow a symlink, which
is D52 and is correct: following one is the arbitrary-file-overwrite primitive agent-skills
#295 rates High. What was wrong was the report. `resolveTarget` throws, the throw reached
the dispatcher's catch-all, and the agent read:

```
kiln guard failed: refusing to follow a symlink: .../zod/README.md
This is a bug in kiln, not in your change. Run `kiln doctor`.
```

Both sentences are false. It is not a bug — it is the design. And `kiln doctor` then prints
`Ready.`, because doctor checks a project's setup and knows nothing about one path. **A
message naming a remedy that does not exist** is the shape this project keeps meeting.

The practical cost is larger than the wording. Editing a README is an ordinary request, zod
is not an unusual repository, and an agent told the tool is broken will either stop or route
around the block. Now:

```
kiln blocked a write to .../zod/README.md: it is a symlink, and kiln does not follow one —
a write through a symlink lands wherever it points, which is how an edit leaves the project.
Write to the file it points at: .../zod/packages/zod/README.md
```

The remedy is the real path, which exists. A dangling symlink says that instead of naming a
file that is not there.

## Finding 2 — the harness asserted that kiln blocks a legitimate push

In `worktree-linked`, three push rows failed. They were right to fail and the expectation
was wrong: `git worktree add -b wt-branch` puts the checkout on a branch of its own, express
ships from `master`, and `vcs.protected` said `master`. Pushing `wt-branch` is allowed
because it is *supposed* to be allowed.

The row had been asserting "a push is blocked" on every layout, which on nine of them
happened to coincide with standing on a protected branch. That is a test that cannot tell a
correct block from a false one.

Both directions are now checked on every layout: the expectation follows `vcs.protected`,
and then the branch this checkout stands on is protected and the same push is tried again.
In the worktree that second half is the interesting one — it is git's own `pre-push` hook,
in a linked worktree, reading hooks from the common dir, refusing a real push. That is D100
measured rather than remembered.

## Finding 3 — a guess about filenames, in the harness

`sourceFile` guessed four spellings of README and crashed on express, which ships
`Readme.md`. It now reads the directory and takes a regular file, README first, and skips
symlinks for the reason above.

## The router's rows

Added to every checkout in the matrix:

| Row | Asserts |
|---|---|
| `R1 resolved` | doctor resolves a route written against a path this project actually has |
| `R2 plan` | the rule's text reaches PLAN, matched against `predicted[]` |
| `R3 review` | and REVIEW, matched against the diff the run produced |
| `R4 recorded` | `state.rules[]` names both stages — the reading is a fact, not a hope |
| `R5 guarded` | the run may not rewrite the rule it is being judged by |
| `R6 half row` | a row filling one column of two is a FAIL, not a silent skip |
| `R7 dead route` | a glob matching nothing in this project is a WARN |

R6 and R7 are the two Cursor ships silently. Running them on ten real projects is what
distinguishes *the parser handles it* from *it holds on a checkout nobody wrote for kiln*.

## What this does not cover, named rather than claimed

- **No package was installed.** Every step command is pointed at something that runs
  offline, and the failing case is asserted deliberately rather than by accident.
- **Nothing was pushed to a real remote.** `origin` is removed first; the real push is to a
  local bare repository.
- **The two-deep superproject reports `unknown` stack**, because detection reads one level
  of `.gitmodules` and the manifest there is one level further down. `init` then asks, which
  is the honest behaviour for something it cannot detect — but it is a limit, not a feature.
