# Acceptance run C9 — the DNA round-two changes, driven as a user would

> 2026-09-24. Claude Code with kiln loaded by `--plugin-dir` from branch `feat/dna-round2`,
> the installed kiln disabled; headless `claude -p`, one turn per user message. The subject is
> C8's Node shop, rebuilt by the same script: eight files of business logic, kiln initialised,
> a bare `origin`. Three things were under test: the scanner tier (D168), the size-and-cap step
> (D161), and whether a bootstrap cut off mid-round, then stripped from the working tree,
> resumes rather than restarts (D162).

## The runs

| # | What happened to the session | What it did | Reported cost |
|---|---|---|---|
| 1 | `/kiln:kiln dna init` | printed `to read: 8 file(s) · 92 line(s) · 1 skeleton(s) · 1 wave(s)` and *"no round of this project has been recorded yet, so there is no time estimate"*, then **stopped and asked for a cap** before dispatching anything | $0.55 |
| 2 | "1. Confirm a cap of 1 wave …" | dispatched one scanner **on Sonnet**; audited its 29 findings against the source, corrected 3 and added 1 missed behaviour; applied 30 — the store and its checkpoint written. **The process was then killed with SIGKILL** before the turn ended, as a crash or a dropped connection would | — |
| — | *(the harness)* | `git stash push -u` — the user tidying the tree — took `.kiln/dna/` away with everything else untracked | — |
| 3 | `/kiln:kiln dna init`, a new session | `kiln dna` reported *no store in the working tree, but a checkpoint of one exists*; the agent ran `kiln dna restore`, `kiln dna check` (PASS), and `kiln dna scan` (*the scan is exhausted*), said it was resuming at Phase 2b, drafted the infra map and stopped at the naming gate. **No file was scanned twice** | $0.72 |

Afterwards the user's `HEAD`, branch, index and stash were exactly as they had left them; the
checkpoint lives on `refs/kiln/dna-checkpoint` and nowhere else. (D169, after this run, moved
it to one ref per project and worktree under `refs/worktree/kiln/`.)

## The scanner tier

| | C8 (fast tier, Haiku 4.5) | C9 (mid tier, Sonnet 5) |
|---|---|---|
| Findings the scanner wrote | 27 | 29 |
| Corrected by the orchestrator's audit | 18 | 3 |
| Missed and added | 5 | 1 |
| Usable as written | 9 of 32 (28%) | 26 of 30 (87%) |

Same eight files, same prompt, same orchestrator. One run each, so it is two data points, not
a benchmark — but the gap is wide enough to decide a default on, and every measured
orchestrator/worker configuration Anthropic has published uses Sonnet workers too (D168).

## What this run did not cover

- The whole bootstrap again — C8 carried it through to a baseline; C9 stopped once resume was shown.
- A time estimate from recorded rounds: the first round of a project has none by design, and
  this subject had no second round.
- The new restructuring, footprint and reconcile commands in a session. They are covered by the
  suite and, for footprint and reconcile, by byte-level parity with the source's Python.
