# Cross-project acceptance — nine checkouts nobody here designed

A fixture answers *does the mechanism work*. A repository somebody else laid out answers
*does it work here*, and that is where every defect this project has found came from. So the
journey matrix was run again, against real clones, by
[`scripts/acceptance-journey.mjs`](../../scripts/acceptance-journey.mjs).

**Safety.** The first thing done to every checkout is `git remote remove origin`, and any
`.kiln/` from an earlier pass is cleared so a run starts where a user starts. Nothing here
can reach an upstream; the push floor is exercised against a local bare repository. Nothing
was forked, starred, or pushed.

## Chosen for shape, not popularity

| Checkout | Shape it brings |
|---|---|
| [chalk](https://github.com/chalk/chalk) | small Node package, ships from `main` |
| [prettier](https://github.com/prettier/prettier) | large Node repo, Yarn Berry, declares `lint` and `typecheck` steps |
| [vitest](https://github.com/vitest-dev/vitest) | pnpm workspace monorepo, `packages/*` |
| [guzzle](https://github.com/guzzle/guzzle) | composer without CodeIgniter, and ships from **`8.2`** — neither `main` nor `master` |
| [requests](https://github.com/psf/requests) | Python: `pyproject.toml` and `setup.py`, no manifest kiln reads |
| [libgit2](https://github.com/libgit2/libgit2) | C and CMake with an incidental `package.json` |
| `husky-owns-pre-push` | `core.hooksPath=.husky` with a `pre-push` the project owns |
| `husky-no-pre-push` | `core.hooksPath=.husky` with only a `pre-commit` |
| `submodules` | a superproject with a real submodule checked out |

The last three are built on top of a real clone, because no shallow clone in the sample
carried them and both shapes are common enough to be worth constructing honestly.

## What each row asked

27 rows per checkout, drawn from the same matrix the fixtures use: detection and the
questions it asks · `init` and the floor · `doctor` · a work through its plan gate · the gate
shut before it and open after · `scope` · verify green, verify red, verify all-skipped ·
`ship` · `report` · `--auto` refused while off · eight guard probes · a real push.

**Result: 9 of 9 checkouts passed every row.**

## What it found

### The floor was absent on every husky project

`core.hooksPath=.husky` is what husky sets, and an enormous share of JavaScript repositories
use it. kiln wrote its `pre-push` into `.git/hooks`, which git does not read when that config
is set. Measured on a real clone:

```
[warn] push floor: core.hooksPath points elsewhere, so a hook written here would never run
Ready.
$ git push origin HEAD
 * [new branch]      HEAD -> main        ← to a protected branch
```

No hook, a warning nobody would stop for, and the closing line said Ready.

`core.hooksPath` is not an obstacle; it is **where the hooks live**. husky sets it,
pre-commit sets it, and every hook-aware tool installs into whatever it points at. kiln does
too now — and D90's first constraint still holds, so a `pre-push` the project already owns is
reported with the exact line to add, never replaced.

### "Ready." over a warning read as fine

Right for a rules budget; wrong for a missing floor, which means D7 item 1 has lost a whole
layer. The closing line now names what was warned about, and still exits 0 — a warning is a
thing to know, not a thing to stop for.

### Two things the runner got wrong, which are worth as much

- It asserted the floor by checking `.git/hooks/pre-push`. That is the wrong place to look on
  exactly the projects where the floor was missing, so the check would have agreed with the
  bug. It asks kiln now.
- It reused a checkout that still held `.kiln/work/` from the previous pass, saw an
  already-approved plan gate, and reported the gate open when it should have been shut. Each
  run starts from a cleared `.kiln/` now.

## The limits the run confirmed rather than closed

- **A hook the project owns stays theirs.** On `husky-owns-pre-push` the real push is *not*
  refused by git, and the row asserts that — the layer that still holds is the PreToolUse
  guard, which the same run exercised. This is tested as a limit, the way the interpreter
  ceiling is.
- **No package was installed.** Each project's declared steps are pointed at a command that
  runs offline, so this measures kiln's verdict machinery, not the projects' suites. The
  first run did make prettier and vitest report `exit 127` and refuse to call it green, which
  is kiln being right; the failing case is now asserted deliberately instead of by accident.
- **No forge.** `ship` is checked as a plan, never as a pull request.
