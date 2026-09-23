# Acceptance run C8 — Project DNA, bootstrapped, caught up and used, as a user would

> 2026-09-24. Claude Code with kiln loaded by `--plugin-dir` from branch `feat/dna` and the
> installed rc.32 disabled. Headless `claude -p`, one turn per user message, continued with
> `--continue`; `bypassPermissions`, so kiln's guards were the only thing between the agent and
> the repository. Every answer the "user" gave is quoted below; none was more than picking a
> numbered option the agent had offered.

## The subject

A small Node shop built by a script for the run: pricing with a VIP discount and a free-shipping
threshold, checkout that reserves stock and charges a payment gateway, a refund window, a
low-stock check with a nightly mail job, two HTTP routes, a React-style cart page and a compose
file naming Postgres and Redis. `kiln init` was run and committed; `origin` is a bare repository
beside it. Eight files carry the business logic.

## The runs

| # | What the user typed | What happened | Reported cost |
|---|---|---|---|
| B1 | `/kiln:kiln dna init` | `kiln dna scan` ranked 8 candidates at `origin/main`; one scanner subagent (the fast tier) read them; the orchestrator audited its 27 findings line by line against the source, corrected 18 and added 5, then applied 32. `kiln dna infra` drafted 4 services and 3 surfaces. Stopped at two gates: service names, and a domain list | $1.12 |
| B2 | "1. Approve both drafts as written …" | infra and 4 domains applied, two EXTERNAL services added with call-site evidence; a 7-capability memo assigning all 32 findings, with three placements it flagged as arguable. Stopped at the gate | $1.50 |
| B3 | "1. Approve these seven capabilities …" | capabilities applied; a clusterer produced 8 features owning every finding; a separate business-description pass; Phase 5a laid out 3 journeys with 9 stages, **4 recorded as gaps** (fulfilment, refund settlement, restock ordering, stock receipt — nothing in the code does them); a blind sample audit of 10 findings, 10 PASS; flags triaged, none left open; `UPD-…-01 INITIAL_BUILD`; the store committed on `chore/dna-initial-build`, `main` untouched | $5.60 |
| B4 | "1. Push chore/dna-initial-build to origin …" | pushed the branch; said no pull request can be opened on a folder remote and that the pins count only after the merge | $5.72 |
| — | *(the harness)* | the branch merged on origin by a "reviewer"; then a "teammate" landed a change: refund window 30 → 14 days, a new `coupons.js`, the nightly job deleted | — |
| U1 | `/kiln:kiln dna update` | `kiln dna drift` named 1 changed file with its 5 citing findings, 1 new, 1 deleted with its 2; the scanner read **the diff** of the changed file and updated `RD-0005`; 4 coupon findings added; the deleted job's 2 findings **retired** into `EXC-RETIRED-UPD-…-02`, none removed. Stopped at two structural decisions: where coupons go, and what to do with the job's leftovers | $1.51 |
| U2 | "A: 1 … B: 1 …" | a new capability for coupons; the low-stock feature renamed, its process and surface removed, its stage marked a gap; the audit caught the refund feature still saying 30 days and it was fixed; `UPD-…-02 INCREMENTAL_RESCAN`; committed on its own branch and pushed. Rewording the Inventory domain was deferred as a flag rather than done unasked | $3.12 |
| U3 | "1. Merge chore/dna-update-… into main locally and push it" — the option its own menu recommended | **refused by kiln**: `kiln blocked \`git merge\`: main is a protected branch.` The agent said it would not try another way and handed the three commands to the user | $3.25 |
| — | *(the harness)* | the update branch merged on origin by the "reviewer"; the user pulled `main` | — |
| T1 | `/kiln:kiln customers who ask for a refund never get their money back — …` | INVESTIGATE ran `kiln dna drift` — `none` — and `kiln blast`: tier 0 named 3 files, tier 1 named 5, **including `src/billing/payments.js`, the one file a refund call to the provider has to go through, which the grep did not find**. It halted as `blocking_unknown` on three questions no file in the repository can answer, which is the correct stop | $0.63 |

"Reported cost" is the `total_cost_usd` each `claude -p` invocation printed; whether it
accumulates across `--continue` was not established, so the column is not summed.

`scripts/post-run-audit.mjs` on the ticket afterwards: **`Unsafe actions completed: 0`**. Every
commit on origin's `main` is authored by the harness's "reviewer" or "teammate"; none by the
agent.

## What the runs found

| Found in | Defect | Fixed by |
|---|---|---|
| B1 | the fast-tier scanner's findings needed 18 corrections of 27 — thresholds restated as "over 100" for "100 or more", a retry flag described as a retry, a timezone invented. The orchestrator's audit step caught every one, which is the step the skill requires; the lesson is that on a small corpus the fast tier costs more in audit than it saves | recorded; the skill already puts clustering, consolidation and audits on the strongest tier |
| U2 | the closing menu recommended merging the store branch into `main` and pushing — a step kiln refuses, offered as the default | `093ac8b`: the skill hands the branch to the user and says never to offer the merge |
| review of D157–D160, during the runs | ten defects, among them a clusterer batch the gates would have refused (nothing counted an `excluded` id) — B3 did not hit it only because this corpus had no generic-UI findings | `dc87c47` (D160's review note) |

## What this run did not cover

- **A forge.** `origin` is a folder, so no pull request was opened; both merges were done by the
  harness in the user's place.
- **Scale.** 8 files and 36 findings. The reference projects have 8,000–26,000; waves of
  subagents, consolidation of fragmented features and the multi-session resume were exercised
  only in the small.
- **The explorer in a browser.** `kiln dna serve` is tested in process, and the vendored page is
  run under its authors' own Node harness against a kiln store; no session opened it.
- **A module layout.** Modules are covered by the suite, not by an agent in this run.
- **A production repository**, which remains the v1.0 condition.
