---
name: kiln-dna
description: Use when the user asks to build, catch up or inspect the project's DNA — the evidence-linked business map of the codebase (/kiln dna init, /kiln dna update) — and whenever a batch has to go into .kiln/dna/store/. Drives the bootstrap and update playbooks through kiln dna's gated commands, fanning scans out to subagents.
---

# kiln DNA

## Overview

Project DNA is what a codebase does, in business terms, reverse-engineered from the code and kept
current as the code moves. Every business claim traces down to findings, every finding to a file
at a pinned commit. Nothing is asserted that cannot be walked back to code.

| Layer | What it is | Ids | Tier (D154) |
|---|---|---|---|
| Evidence | findings scanned from source, each with `module` and `evidence` | `RD-####` | 1 |
| Capability axis | Domain → Capability → Feature; features own findings through `rd_ids` | `DOM-{ABBR}-XX-YY` | 1 (features) · 2 |
| Process axis | Flow → Stage → Process — journeys, not modules | `BF-NN.S#.P#` | 2 |
| System axis | services, surfaces, components, topology | `SVC-`, `SRF-`, `CMP-` | 2 |
| History | one update record per round; intakes, releases, debts | `UPD-YYYY-MM-DD-NN` | 2 |

The method is tps-project-dna's, kept verbatim beside this file: [glossary.md](glossary.md) (every
definition and closed enum), [id-schemes.md](id-schemes.md), [quality-gates.md](quality-gates.md),
[agent-orchestration.md](agent-orchestration.md), [bootstrap-playbook.md](bootstrap-playbook.md),
[update-playbook.md](update-playbook.md), [dna-store.md](dna-store.md), [dna-erd.md](dna-erd.md),
[bpm-alignment.md](bpm-alignment.md). Those pages were written for another project's scripts —
**read [reading-note.md](reading-note.md) first**: it says what each script and file is in kiln.

**The store has one door.** `.kiln/dna/store/` is written only by `kiln dna apply <batch.json>`,
which assigns the counted ids, derives every computed field, runs every gate, and writes nothing
if one fails. An `Edit` into the store is refused. You and your subagents write **batches**.

## When to Use

- `/kiln dna init` — no store yet, or a store with no findings: the bootstrap below.
- `/kiln dna update` — a store exists and the code has moved: the update section below.
- Any time a batch is about to be written into the store.

**When NOT to use:** `/kiln dna` alone, `check`, `scan`, `drift`, `infra`, `build`, `serve` — those are
commands. Run `kiln dna <verb>` and print what it said. `update` on a store with no findings is
refused and pointed at `init`: a diff scan of nothing is a full scan nobody agreed to (D79).

## The commands

| Command | What it does |
|---|---|
| `kiln dna` | counts, pins, whether the gates pass |
| `kiln dna check` | every gate, one line each |
| `kiln dna scan [--limit n] [--out dir]` | the unscanned candidates, densest first; `--out` writes one batch skeleton per group |
| `kiln dna drift` | fetch, then how far the code has moved from what the store read |
| `kiln dna update [--limit n] [--out dir]` | the drift, and skeletons for the changed and new files |
| `kiln dna infra [--out file]` | a draft batch of services and surfaces, for the user to review |
| `kiln dna apply <batch.json>` | the one write; prints each id it assigned (`RD-0012 ← f3`) |
| `kiln dna build` | derive again, change nothing |
| `kiln dna serve` | the explorer on 127.0.0.1, behind a token; run it in the background and give the user the address it prints |

A batch: `{ "settings": {…}, "upsert": { "<collection>": [records] }, "remove": { "<collection>": [ids] }, "scan": {…} }`.
A new record without an id gets the next counted one (findings, capabilities under their
`domain_id`, features under their `capability_id`, flows, stages, processes, ledger rounds). A
domain's abbreviation and a service's mnemonic are chosen with the user, never counted. A record
may carry `key`, and `"@<key>"` anywhere in the same batch becomes its id — so findings and the
feature that owns them can arrive together. `null` removes a field. Derived fields
(`service_id`, `surface_id`, `component_id`, a finding's `feature_id`, components, hop-lift
edges) are refused: they are computed.

**Scratch.** Batches are temp files: `.kiln/tmp/<work-id>/dna/` while a work is open, otherwise
`.kiln/tmp/dna-rounds/`.

## Bootstrap — `/kiln dna init`

Multi-session by nature: the reference projects took 8,000–26,000 findings over many sessions.
The store is the progress record, so **resume by reading it** — `kiln dna` and `kiln dna scan`
say which phase you are in (findings but no domains: Phase 3; features with findings unowned:
Phase 4; and so on). Say which phase you are resuming and why, then continue.

**Phase 0 — the snapshot.** Run `kiln dna scan`. Its first line names the commit each
repository is read at. `not the integration branch … never pinned` means there is no
`origin/<branch>` and no local one: stop and tell the user — a store scanned there cannot be
pinned (D80), and every later drift check would be wrong. Otherwise report the counts.

**Phase 1–2 — scan to exhaustion.** Repeat until `kiln dna scan` says the scan is exhausted:

1. `kiln dna scan --limit 30 --out <scratch>/round-<n>` — one skeleton per group of files.
2. Dispatch **one subagent per skeleton**, in waves of 3–6 ([agent-orchestration.md](agent-orchestration.md),
   "Dispatch in small waves"), with the template in [scanner-prompt.md](scanner-prompt.md):

   ```
   Task(subagent_type: "general-purpose", model: <the fast tier>, prompt: <scanner-prompt.md, filled in>)
   ```

3. Audit each skeleton by content before trusting a notification: it parses, `scan` is
   untouched, every finding's `module` is one of `scan.files`, every proposition is one business
   sentence. A skeleton with no findings for a file is allowed — the file was read and held
   nothing business-meaningful — and it is still recorded as scanned.
4. `kiln dna apply <skeleton>` for each, one at a time. A refusal quotes the failing gate: fix
   that batch and apply it again; never loosen a record to make a gate pass.

**Phase 2b — the infra map.** `kiln dna infra --out <scratch>/infra.json`, then show the user a
table of the drafted services (id, kind, roots) and surfaces (id, kind, file). Naming a service
is theirs: apply only after they confirm or edit it. Add EXTERNAL services the findings name
(a payment provider, a mail service) with the user, and the process-to-EXTERNAL call sites as
`EXTERNAL_HOP` edges once processes exist — hop-lift derives service topology from them.

**Phase 3 — taxonomy.** Ask the user for a business-authored list of domains first; a
code-derived one fragments ([bootstrap-playbook.md](bootstrap-playbook.md), Phase 3). Draft the
Domain → Capability skeleton from that and a read of the findings, each domain with its core
business object, lifecycle and vocabulary, and each capability through the Identity litmus in
[glossary.md](glossary.md). Present it as a memo with the proposed `DOM-{ABBR}` table, and apply
it only on the user's explicit yes. This is the gate every later phase stands on.

**Phase 4 — features.** Per capability (or batch of them), dispatch the template in
[clusterer-prompt.md](clusterer-prompt.md) with the capability's full record and every finding
proposed for it. It writes a batch of features (and `excluded` entries) with `rd_ids`, and a
separate flags file of `misassigned` and `taxonomy_gap` — only the batch goes to `kiln dna apply`. Then, in order: re-dispatch every `misassigned` to its named capability; collect every
`taxonomy_gap` into one extension proposal for the user; a consolidation pass over fragments;
size and classify. Gates hold the partition: a finding owned twice fails the write, and
`kiln dna check` warns while findings remain unowned. Generic UI and engineering-standard
findings go to `excluded`, never the business tree.

**Phase 4b — business descriptions.** A separate pass: [describer-prompt.md](describer-prompt.md)
gets only a feature's `name` and `description`, never the findings — writing business prose
while holding the code is how jargon leaks in. The jargon gate runs on every write.

**Phase 5 — processes.** Phase 5a is **whole-inventory**: hypothesise journeys top-down across
all capabilities, lay out stages as lifecycle phases, then attach evidence; a stage nothing
implements is a recorded gap (`gap`, `gap_note`), never deleted and never filled with an
invented process ([bootstrap-playbook.md](bootstrap-playbook.md), 5a). Seed `settings.actors`
before 5b. Phase 5b fills process detail per flow with [process-prompt.md](process-prompt.md).

**Phase 6 — links.** Put the repositories' remotes into `settings.evidence_sources` with
`link_template`s read from `git remote -v`, never guessed.

**Phase 7b — sample audit.** Sample `min(30, max(10, 2%))` of the round's findings and dispatch
fresh agents with [auditor-prompt.md](auditor-prompt.md) — the cited lines and the feature they
sit in, never the clustering agent's reasoning. Above ~10% `FAIL-*`, sweep everything sharing the
failure's root cause before the round closes.

**Phase 7c — flags.** Every flag the round raised gets a status (`OPEN`, `ACCEPTED`, `REJECTED`
with its reason, `DEFERRED`, `SETTLED`) on the round's update record. The round does not close
with an `OPEN` one.

**Phase 8 — baseline.** One `updates` record, `kind: "INITIAL_BUILD"`, carrying the totals,
`audit_sample` and `flags`. `kiln dna check` passes. The store is tracked: commit
`.kiln/dna/store/` on a branch of its own and hand the user the pull request — the pins take
effect when it merges into the integration branch (D80). Merging it is the user's, through their
forge: never offer to merge into or push to the integration branch yourself — the guard refuses
it, and a menu that recommends it hands the user a step that fails.

## Update — `/kiln dna update`

The code moved; the store catches up. "Diff, don't re-scan" ([update-playbook.md](update-playbook.md)):

1. `kiln dna drift` — fetches the integration branch and names every changed, new and deleted
   file, with the findings each puts in doubt. `unknown` means a fetch failed: say so and stop
   unless the user wants to go on with what the last fetch saw.
2. `kiln dna update --out <scratch>/update-<n>` — skeletons for the changed and new files. A
   changed file carries `was` (the blob it was read at) and `cites` (the findings that name it);
   the scanner reads the diff, not the file ([scanner-prompt.md](scanner-prompt.md)).
3. Apply each skeleton as in the bootstrap. A cited finding whose behavior changed comes back as
   an upsert by its id; one the diff made untrue is reported, not deleted.
4. **Deleted code.** A finding is never removed (id-schemes.md). A finding the code no longer
   holds — its file deleted, or reported untrue in step 3 — leaves its feature's `rd_ids` and
   joins the round's `excluded` entry — `id: "EXC-RETIRED-<the round's UPD id>"`,
   `catalog: "RETIRED"`, a `disposition` saying what removed it — in one batch. The source's playbook has no step for this; without it a map only ever grows.
5. Thread new findings into features with [clusterer-prompt.md](clusterer-prompt.md), verdicts
   `UPDATE` / `NEW` / `IGNORE` against each capability's full existing feature list (update-playbook
   §4). Then PLANNED features (§4b), open debts (§4c), and the sample audit over this round's
   findings only (§5b).
6. One `updates` record, `kind: "INCREMENTAL_RESCAN"`, with the round's numbers; `kiln dna check`
   passes; the store change goes on its own branch and the user gets the pull request. The pins
   move when it merges.

## Model tiers

Scanning and mechanical classification: the fast tier. Clustering, consolidation, taxonomy
proposals and the sample audit: the strongest tier you have — one wrong verdict there propagates
([agent-orchestration.md](agent-orchestration.md), "Model tiers").

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "I'll edit features.jsonl directly, it's one field." | The store is refused to `Edit`. Write a batch; the gates are the point. |
| "The subagent said it finished." | A notification is not content. Audit the skeleton before applying it. |
| "The taxonomy is obvious from the folders." | Code-derived taxonomies fragment: 18 domains became 9 on the reference project. Ask, memo, get a yes. |
| "This finding fits the nearest capability well enough." | That is force-fitting. `misassigned` or `taxonomy_gap`, never the nearest bucket. |
| "I'll write the business description while I have the code open." | That is how `ir.http` ended up in a PM's summary. Separate pass, name and description only. |
| "One flow per module is a clean process axis." | It is the capability axis relabelled. Journeys cross modules. |
| "The scan is nearly exhausted; call it done." | Done is `kiln dna scan` saying so. |

## Red Flags

- You are about to write inside `.kiln/dna/store/` with anything but `kiln dna apply`.
- A skeleton's `scan` block was edited, or a finding's `module` is not one of its files.
- A domain or capability was applied without the user's explicit yes.
- A subagent received a summary instead of the real findings or the real lines.
- A process was invented to fill a stage.
- The store was scanned off the integration branch and you are about to call it pinned.
- Your closing menu offers to merge the store branch into the integration branch.

## Verification

- [ ] `kiln dna check` ends `RESULT: PASS`.
- [ ] `kiln dna scan` says the scan is exhausted (bootstrap) or lists only what this round did not reach, and you said which.
- [ ] Every structural decision (taxonomy, taxonomy extension, infra names) has the user's yes in this conversation.
- [ ] The round's update record carries `audit_sample` and no `OPEN` flag.
- [ ] The store change is on its own branch, not the integration branch.
