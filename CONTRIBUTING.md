# Contributing to kiln

kiln blocks actions at runtime, so a change that is merely plausible is not enough: the
promise it touches has to stay measurable afterwards. Everything below follows from that.

## The gate

```
npm run lint && npm test
```

That is the whole gate, and it is what CI runs on every pull request. Node 20.10 or newer,
no other prerequisite — kiln has zero runtime dependencies and intends to keep them.

## Before you open a pull request

1. **Bring a test that fails without your change.** Not a test that exercises the change —
   one that goes red if the change is reverted.
2. **If you touched a guard, say which of the seven promises it belongs to.**
   `tests/d7.test.mjs` holds the promise and its proof in the same file for exactly this
   reason; a guard change that leaves that file untouched usually means the promise moved and
   nobody noticed.
3. **Run the lint.** Eight of the ten style rules in the design are enforced by ESLint —
   two parameters per function, twenty lines per function, complexity 10, depth 3, `===`,
   `const`, no `var`, no parameter reassignment. They are not suggestions; the build fails.
4. **Keep the dependency count at zero.** A pull request that adds a runtime dependency needs
   to argue for it in the description, because removing them was a decision, not an accident.

## Changing behaviour the design already decided

The design lives in [`docs/design/`](docs/design/) and is not decoration: 201 numbered
decisions, each with the reasoning that produced it.

- **Disagreeing with a decision is welcome.** Cite it by number, say what you measured, and
  propose the replacement. Being wrong in public with a number attached is the format the
  whole log is written in.
- **A change that contradicts a decision needs a new decision entry**, not a silent edit. The
  superseded line stays visible; the history is the point.
- The architecture file outranks the other design documents where they disagree.

## Things this project asks for that others do not

- **Measure, do not assume, what the harness does.** Claims about hook behaviour — what
  blocks, what fails open, what a timeout does — belong in
  [`live-harness-evidence.md`](docs/design/2026-09-21-live-harness-evidence.md) with the
  version they were measured against. Three holes that every green test had missed were found
  that way.
- **A guard that only ever blocks is indistinguishable from a broken one.** If you tighten a
  guard, bring the case that must still pass as well as the case that must now block. A false
  positive teaches an agent to route around kiln, and the habit it builds does not know which
  blocks are real.
- **Forked files record what changed.** Five skills under `skills/` are forks of
  [Superpowers](https://github.com/obra/superpowers); [NOTICE](NOTICE) names the fork commit
  and, per file, what kiln changed. Edit one, extend its entry.

## What is not asked of you

Acceptance runs need a real repository, a real ticket, and a person to grade the result.
They are the maintainer's job, not a contributor's.

## Cutting a release

```bash
git switch -c chore/v1.0.0-rc.N
npm version prerelease --preid rc --no-git-tag-version
```

`npm version` writes `package.json` and its lock, and its `version` script moves both plugin
manifests with them (D184). Commit it as `chore: v1.0.0-rc.N` and land it like any other change.
Once it is merged, tag the commit main holds and publish the release:

```bash
git tag v1.0.0-rc.N <merged commit> && git push origin v1.0.0-rc.N
gh release create v1.0.0-rc.N --prerelease --generate-notes
```

The tag comes after the merge because main takes squash merges only: a tag `npm version`
made on the branch would name a commit main never holds.

## Reporting a bug

Open an issue with the smallest command sequence that reproduces it, your Node version, and
your harness version. If the bug is that a guard **allowed** something it should have blocked,
read [SECURITY.md](SECURITY.md) first — that is a vulnerability report, not an issue.
