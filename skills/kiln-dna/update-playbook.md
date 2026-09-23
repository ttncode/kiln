# Project DNA — incremental update playbook (after a source pull)

> **In kiln:** this page is tps-project-dna v2.18.1's text, verbatim. The scripts and files it names
> are that project's; [reading-note.md](reading-note.md) says what each one is in kiln, and where
> the two disagree, kiln's commands win.

Run this whenever the source repos move ahead of the pinned snapshot. Validated end-to-end on the
reference project (573 changed files → 16 genuinely new + 37 re-scan files → 137 findings → 27
Features corrected + 18 created, in one round). The goal is **all reports current**, not just the
raw corpus — finish the whole ladder or record explicitly which rungs were deferred.

## 1. Diff, don't re-scan

- Get the new HEADs. `git diff <pinned>..HEAD --stat` per repo → exact changed-file list broken
  down Added/Modified/Deleted/Renamed.
- Cross-reference against the `ALREADY_SCANNED` ledger: files both already-scanned AND modified are
  confirmed re-scan candidates.
- Files modified but never scanned (previously SHELL/OTHER/TEST) are NOT automatically skippable —
  their classification may have changed. Re-run the density-ranking scripts against the current
  repo state: they surface both genuinely-new files and reconsidered files as unscanned CANDIDATEs
  with no extra scripting. (Reference round: 533 nominally-changed → 16 actually worth scanning.)
- Ask the user before skipping any large ambiguous population; that's a real question, not a
  silent assumption.

## 2. Scan the diff, not the file

Batch re-scan files by **actual diff size** (`git diff <pinned>..HEAD -- <file>` line count), not
file size — a 9,000-line file can have a 40-line diff. Feed each scanning agent the real diff (plus
minimal surrounding context), instructing it to report only NEW/CHANGED findings, never re-derive
what's already documented for unchanged code. Genuinely new files get whole-file first-time scans.

## 3. Merge with the standard gates

One-off `_merge_<date>_findings.py`: backup, sequential new `RD-####` ids continuing the corpus,
bijection/no-gaps/counts-match-recount. Compare rd_id numerically (`int(rd_id.split('-')[1])`) —
lexicographic string comparison on `RD-####` ids is a real, previously-hit bug.

## 4. Thread into the capability axis (the step that keeps reports HONEST, not just bigger)

The new findings' category tags are evidence bookkeeping; the reports only become current when the
Feature text reflects them:

1. Group new findings into domain/topic clusters.
2. Dispatch parallel clustering agents; each reads the real finding text AND the real existing
   Feature list of its target capability (full text, not summaries), and returns per cluster a
   verdict: `UPDATE` / `NEW` / `IGNORE` (definitions in glossary.md). Instruct agents to FLAG
   findings that don't belong in their cluster instead of force-fitting — follow up flagged
   orphans with dedicated dispatches.
3. Run a script-based completeness check: every new rd_id covered exactly once across all
   proposals (no gaps, no duplicates) BEFORE writing any apply script.
4. Mechanical apply: UPDATE revises name/description/size + appends rd_ids (dedup) and recomputes
   evidence/layer/category counts from real finding data; NEW creates the next sequential feature
   id with hand-classified glossary axes; every `feature_count` is recomputed by fresh recount,
   never incremented. Gates: total = old + created; ids unique; all non-ignored new rd_ids present;
   counts match recount.

UPDATE verdicts are the point: stale numbers in existing descriptions (a window that grew from 3 to
12 months) get corrected, not merely footnoted.

## 4b. PLANNED confirmation (expanded v2.5.0 — the other half of DNA-first id reservation)

If the intake process (`tps-quantification-intake` → `scripts/apply_intake.py`) has reserved any
`status: PLANNED` features, this round must resolve EACH one explicitly:

- **The promised code landed** — new findings (typically from the MRs/commits citing the PLANNED
  id) thread to that feature: attach the real confirming `rd_ids`, **REMOVE the `status` field
  entirely** (absent = evidence-backed; there is no "CONFIRMED" value), and fill the remaining
  `business_description` keys (`input`/`process`/`output` — a reservation carries only
  `what_it_does`, and check_gates' 4-key completeness gate stops exempting the feature the moment
  PLANNED clears).
- **It hasn't landed yet** — leave the reservation standing and note it in the round's
  update-history entry.

Scan-born features never carry PLANNED — the status enters the data through `apply_intake.py`
only. Skipping this check silently turns reserved ids into orphans; the gates keep the trace
honest (PLANNED ⇒ empty `rd_ids`, and every PLANNED feature must trace to an intake round's
`proposed_id`).

## 4c. Debt settlement (added v2.5.0)

Walk EVERY `OPEN` entry in `_debt_ledger.json` before the round closes:

- **Settled with evidence** — this round actually paid what was owed (the hotfix got scanned, the
  outdated map region got corrected, the unruled area got coverage): set `status: SETTLED` and
  `settled_by: <this round's UPD- id>` (gate-checked: `settled_by` must cite a real round in
  `_update_history.json`).
- **Still open** — record WHY it stays open in the round's update-history entry.

A round that silently ignores open debts is incomplete — the debt ledger is the DNA's memory of
what it owes itself, and it only works if every round answers every open entry, one way or the
other.

## 4d. Topology round — service reachability (added v2.18.0)

Run when the builder or `check_gates.py` reports `services: every EXTERNAL service has an inbound
TOPOLOGY edge` FAIL, and after any round that adds a service. The builder already lifts
function-level `EXTERNAL_HOP` evidence into `TOPOLOGY` edges on its own (`derivation:
"hop-lift"`); this round handles what hop-lift cannot see. Module-level edge derivation stays
banned — an agent authors an edge only after quoting the call. Written so a fresh-context agent
(Sonnet is enough) can run it end-to-end given only this section, the skill folder and the
project dir; it is a dry run until step 3 rebuilds.

Convention to hold in mind throughout: an EXTERNAL service's `root_paths` is the module that
WRAPS it (`payment_paypal/`, `web_unsplash/`), so findings inside that module carry
`service_id` = the EXTERNAL service — that is attribution, not a call. The CALLER of that
module's outbound calls is the service that CONTAINS the module (the backend); hop-lift resolves
it that way (longest owning `root_paths`, the callee's own excluded), and so must you when you
author: `from` is never the EXTERNAL service itself.

1. **Dry run.** `python scripts/topology_round.py <project-dna-dir>` → console report +
   `_topology_round.draft.json`. Every `unreachable[]` entry says how the map ever learned of
   that service (`discovered_via`: findings attributed by `service_id`, findings mentioning its
   name tokens, declared `root_paths`) and proposes exactly one action. Nothing is applied.
2. **Resolve each entry — one action, checked against source, never from the draft alone:**
   - `author_edge`: open the cited RD ids, find the real outbound call (HTTP client / SDK /
     mail send). Append to `_infra_map.json` `edges[]`:
     `{"from": <caller>, "to": <service>, "type": "CALLS", "evidence": "<file:line>", "rd_ids": [...]}`
     — `evidence` is ONE quoted call site, not the module; further call sites for the same
     pair go into `rd_ids` (the findings whose evidence spans contain them), never a second
     edge. Authored edges that predate v2.18.0 carry neither field — `check_gates.py` only
     warns about them; backfill one only when you have opened the call site yourself. If none
     of the cited findings contains a call, do NOT author; fall through to the next action.
     A real outbound call you meet on the way whose target is NOT in `services[]` (the pilot
     hit Google Maps beside Nominatim) is never turned into an edge to a service that does not
     exist: list it under `unmodeled_targets` in the round entry — adding a service is a
     `bootstrap_infra_map.py` draft step, not this round's.
   - `fill_root_paths_then_rebuild`: the integration lives in module(s) no service owns. Add
     them to the EXTERNAL service's `root_paths` (that is what `finding.service_id` and hop-lift
     key on); if those modules were never scanned for calls, run
     `bootstrap_dd_sources.py --only calls` over them first so the next rebuild has hops to lift.
   - `retire_or_scan`: no evidence attributes to or mentions the service. Either scan its
     module (as above) or accept it is a name without a system behind it — remove it from
     `services[]` and say so in the round entry. A service kept "because it might exist" is
     exactly the defect this gate exists to catch.
3. **Rebuild and gate.** `build_dna_store.py`, then `check_gates.py` must be clean. Record on the
   round entry (§6): `"topology": {"lifted": n, "authored": [...], "root_paths_filled": [...],
   "retired": [...], "unmodeled_targets": [...], "still_unreachable": []}` — the last list must
   be empty for the round to count as done.
4. **Dispatch shape** (agent-orchestration.md rules apply): the agent returns the draft it acted
   on, the exact diff to `_infra_map.json`, and the gate output — never the prose claim "edges
   were added". A reviewer re-runs step 1 on the result: the draft must come back empty.

## 5. Regenerate everything — including hand-maintained pages

Re-run every generator (capability map, process map, coverage matrix, raw views, MD renditions).
Then walk the list of hand-crafted pages that hardcode data (on the reference project:
`system-map.html` hardcodes per-domain feature counts AND power-diagram territory weights calibrated
to those counts — both need manual update + offline weight re-solve when counts change). Keep that
list current in this file when new hand-crafted pages appear.

**Authored-judgment lookup files are a third class here** (v2.17.0) — content that is
agent-authored ONCE and only mechanically re-RENDERED afterwards (Pattern 2's
`_bp_process_diagrams.json`, Pattern 1's `short_label` lookup). Re-running every generator does
NOT refresh these, and a methodology-recipe change silently strands every entry authored under
the old recipe: diagramming.md retired Pattern 2's rule-bucket recipe at v2.10.0, and all 350 of
OdooDNA's previously-authored diagrams stayed on the retired recipe unnoticed until a judged
benchmark scored P6 at the floor two versions later. So: when a recipe governing authored content
changes, run `check_bpm.py` (Group 1 #12 measures the stale-diagram backlog mechanically) and
either re-author the affected entries THIS round or open a debt-ledger entry for them — never
assume "regenerate everything" covered content that regeneration only re-renders.

Evidence-layer drafts are part of "everything" (v2.7.0): if the pull's changed-file list touches
any `bootstrap_dd_sources.py` extractor's scope (view XML → ui; model py → db; controllers →
api/err; `.po`/`.pot` → i18n; compose/k8s → deploy; HTTP-client/mail-send/SDK py or `ir.cron`
XML → calls), re-run the affected extractors (`--only` subset is fine on an update round, unlike
a bootstrap) — plus `bootstrap_infra_map.py` when topology-bearing files changed — in the SAME
round as the finding re-scan, recording refreshed counts + the new pin in `_PROGRESS.md`
(dna-store.md's "Boundary (station discipline)" note: this is collection, owned by this round,
never deferred to the DD station).

If the project has Detail Design artifacts (`tps-solution-design`, `project-dna/detail-design/`),
run that skill's whole-project sync mode here too: it scans every `DD-<SRF-id>.json` for a stale
`dna_version` stamp against this round and re-renders what's stale — same mechanism as the pages
above (staleness is machine-visible, never "maintained" by hand), just scoped to Detail Design's
own artifact tree instead of the report pages.

## 5b. Random-sample audit (added v2.4.0)

Same mechanism as bootstrap-playbook.md's Phase 7b, narrower scope: sample
`min(30, max(10, 2% of THIS round's touched findings))` — not the whole historic corpus, that was
the first audit's job. Blind re-verification against real source, four verdicts
(PASS/FAIL-MISASSIGNED/FAIL-FABRICATED/FLAG-AMBIGUOUS), error rate above ~10% triggers a full
sweep of the failure's root cause before the round counts as done. Record `audit_sample` on the
round entry (§6 below already documents the required round-entry shape).

## 6. Close the loop

- Update `ALREADY_SCANNED` with every newly-scanned file; re-run density scripts → confirm 0
  unscanned CANDIDATEs.
- Re-pin the snapshot hashes in the progress log.
- Append the round's entry to `_update_history.json` (kind `INCREMENTAL_RESCAN` — or `RESTRUCTURE`
  for a no-rescan structural apply round, added v2.1.0 — all real numbers from the gate-checked
  scripts) and regenerate the update-history report. **Round-entry required shape (v2.1.0):** every
  entry carries `id`, `kind`, `date`, `source_pins` (carried forward with a note when no rescan
  happened), `scope`, `corpus_totals` (`findings_total` + `by_category`, restated even when the
  corpus is untouched), `capability_axis` (`domains`/`capabilities`/`features`/`excluded_groups`),
  `process_axis` (`flows`/`stages`/`processes`/`processes_control`), `views_published`, `notes` —
  renderers display all rounds uniformly, so a lean entry missing e.g. `corpus_totals` breaks the
  page for every round, not just its own card. Include the optional `audit_sample` field (added
  v2.4.0, `{sampled, pass, fail, error_rate}`) from the round's §5b random-sample audit. Include
  the optional
  `methodology_version` field (added v2.0.0) recording which `tps-project-dna` methodology version
  produced THIS round's verdicts — a project's DNA can span rounds built under different
  methodology versions over time, and a reader should be able to tell which rules governed any
  given round without cross-referencing dates against the skill's own CHANGELOG.md by hand.
- Verify via a real local `http.server` (never `file://` — browser preview panes silently no-op
  cross-page navigation on file URLs): 0 console errors, spot-check one corrected Feature's new
  text actually renders.
- Write the progress-log section; update memory if a new reusable lesson emerged; commit the
  published reports (ask before any push).
- **Merge back (added v2.1.0)**: if the round ran on a side branch or an isolated worktree, the
  round is not closed until either (a) that branch is merged into the project's main line, or
  (b) main's `_PROGRESS.md` gets an explicit deferred-pointer entry (branch name, what it
  contains, why the merge is deferred). Without this, main's store and progress log look current
  while actually being superseded — the next session reads stale DNA with no signal that newer
  data exists one branch away.

## 7. Migrating a project onto a renamed skill convention (added v2.7.30)

Not every update round is new source data — sometimes the skill's own METHODOLOGY renames a
structural convention (a folder name, a config key) and every project carrying the old name needs
to catch up. The `design-doc/` → `project-dna/` rename (v2.7.30, see CHANGELOG.md) is the first
case of this; the same steps apply to any future rename of this shape.

1. **Fetch and check for concurrent work first** — `git fetch origin`, `git status --short
   --branch`. If another session has pushed since your last sync, stop and reconcile before
   touching anything (this is a whole-repo mechanical edit; a stale base makes conflicts painful).
2. **Physically move the directory with git, not a copy**: `git mv design-doc project-dna` —
   preserves file history as renames instead of delete+add pairs.
3. **Sync this project's local skill copies** from the canonical marketplace repo
   (`tps-project-dna`, and `tps-solution-design` if the project also has it) — a stale local
   skill copy would still write to/read from the old name.
4. **Run `scripts/migrate_project_dna_rename.py <project-root> --apply`** (this skill's own
   canonical migration script — word-boundary-safe: it will NOT corrupt an unrelated identifier
   that merely contains the old token as a substring, e.g. a function named
   `write_basic_design_docs()` correctly keeps its own name because `"design_doc"` is a substring
   of the unrelated plural `"design_docs"`; see the script's own docstring for exactly which files
   it treats as historical record and leaves untouched — CHANGELOG.md entries and dated
   `references/proposals/*.md` files describe what was true AT THE TIME, and rewriting them would
   misrepresent history, not just rename a token).
5. **Run `check_gates.py <new-dir-name>`** — must PASS (a version-stamp WARN is expected and fine;
   a rename touches zero DNA data, so every data-integrity gate must be unaffected).
6. **Commit** — one commit for the whole rename, referencing the CHANGELOG.md entry that explains
   why. Push once verified.

This is a whole-project mechanical operation, not a data round — it does not need a new
`_update_history.json` entry (nothing about the DNA's content, counts, or methodology_version
changed), but IS worth one line in `_PROGRESS.md` recording the date and that gates still passed.

## Explicit scope boundaries to re-check each round

- Process axis: new Features are NOT auto-linked into `related_feature_ids` — that mapping is its
  own pass; either run it or record that it's deferred.
- Any round touching Process records (actors, rule buckets) follows the same closed-vocabulary
  rules as bootstrap Phase 5 (added v2.7.0): actor names resolve to `_actor_registry.json` (new
  ones via `proposed_actors` + near-duplicate check), bucket entries pass glossary.md's bucket
  litmus + rule-sentence bar, strong claims match their quoted guard predicate, and the round
  runs the strong-claim spot-check (agent-orchestration.md) before closing.
- Older/parallel catalogs (e.g. a frozen first-generation capability catalog) either get the same
  treatment or are explicitly marked as frozen snapshots in the progress log.
