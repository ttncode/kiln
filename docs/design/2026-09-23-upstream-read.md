# Upstream read since the fork point — 2026-09-23

D69 forked five superpowers skills plus one reference file rather than tracking them, and
named the cost out loud: *"upstream's future measured fixes will not arrive on their own"*.
The compensation it wrote into the release checklist is one human step — read upstream's
releases from the fork commit forward and adopt anything worth adopting **as a decision
entry, never as a merge**. This is that step, run for the first time.

## What upstream has done since

| Question | Answer |
|---|---|
| Latest release | **v6.4.1** — the fork point. No release since |
| `main` ahead of the fork commit by | **0 commits** |
| Where work is happening | feature branches (`brainstorming-skill-scaling`, `agentic-end-to-end-testing`, `add-worktree-consent-step`, …), none merged |

So there is nothing to merge and nothing to adopt from released code. The interesting half
was the issue tracker, which §6.1 rule 9 makes part of the method anyway: *"checking three
validated projects' issue trackers for the same bug"*.

## The record pointed at something that is not a commit

`NOTICE` read *"Fork point: v6.4.1, commit b92c4fa87ea1252077a7f7d3bf420e52325dd25e"*, and
that SHA is the **annotated tag object**, not the commit it points at:

```
$ gh api repos/obra/superpowers/commits/b92c4fa...
No commit found for SHA: b92c4fa87ea1252077a7f7d3bf420e52325dd25e (HTTP 422)

$ gh api repos/obra/superpowers/git/ref/tags/v6.4.1
{"sha":"b92c4fa...","type":"tag"}      # the tag object
$ gh api repos/obra/superpowers/tags
v6.4.1  5bf4e78011075bcfc0dc295f0724994cd123ee71   # the commit
```

`git checkout b92c4fa` works, because git resolves the tag. The compare API — which is how
anyone actually answers *what changed since the fork* — returns 404. NOTICE calls the fork
commit *"the whole provenance record"*, so a record that half the tools cannot resolve is
worth one line to fix. Both are now recorded, with which is which.

## superpowers #2362 — kiln's fork had the same bug

> *brainstorming visual companion: a screen containing `$'` (e.g. `'NT$' + amount`) has its
> JS rendered as page text — `wrapInFrame` uses screen HTML as a `replace()` replacement
> string*

kiln forked the visual companion (D11) and carried the line verbatim:

```js
return renderBranding(frameTemplate).replace('<!-- CONTENT -->', content);
```

`String.prototype.replace` with a **string** replacement treats `$&`, `` $` ``, `$'` and
`$1` as substitutions. Measured in kiln's copy before the fix:

```
'<main><!-- CONTENT --></main>'.replace(marker, "<p>Total: NT$' 1,200</p>")
→ '<main><p>Total: NT</main> 1,200</p></main>'
```

The rest of the screen was swallowed and a closing tag landed in the middle of the content.
A brainstorming screen showing a price in Taiwan dollars, or any string containing `$&`,
renders as a broken page.

Two sites, both fixed with `split().join()` — the idiom `renderBranding` two functions above
was already using, so the fix is the file's own style rather than a new one:

| Site | What flowed through it |
|---|---|
| `wrapInFrame` | the screen's HTML, written by whoever wrote the screen |
| the helper injection | kiln's own `helper.js`, so latent rather than live — fixed for the same reason |

Both are exported and tested now.

## Not adopted, with reasons

| Upstream issue | Why not |
|---|---|
| #2370 — `executing-plans` recovery when helper scripts are not exposed by the host | D69 cut the `sdd-workspace` resolution from `kiln-implement` and repointed the ledger at `state.json`. The failure needs the subsystem kiln deleted |
| #2368 — opt-in DAG/wave execution for independent plan tasks | v1 runs tasks natively and in order. Parallel execution is a ceremony change, not a fix, and nothing measured here asks for one |
| #2356 — optional parallel tester role in `subagent-driven-development` | kiln does not ship that skill (D69) |

## The step, as it should run next time

1. `gh release list --repo obra/superpowers` — is there a release after the recorded one?
2. `gh api repos/obra/superpowers/compare/<fork commit>...main` — has `main` moved?
3. `gh issue list --repo obra/superpowers --search "created:><fork date>"` — and read them
   against the files `NOTICE` says kiln forked.

Step 3 is the one that paid this time, and it is the one a release checklist is most likely
to skip, because steps 1 and 2 both answered *nothing changed*.
