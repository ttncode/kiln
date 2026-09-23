# Project DNA — quality gates (non-negotiable)

> **In kiln:** this page is tps-project-dna v2.18.1's text, verbatim. The scripts and files it names
> are that project's; [reading-note.md](reading-note.md) says what each one is in kiln, and where
> the two disagree, kiln's commands win.

Every one of these exists because its absence produced a real bug on the reference project. They
apply to BOTH playbooks.

## Before mutating data

- **Script-only mutation.** Data files change only via a committed one-off script
  (`_merge_*`/`_apply_*` naming), never hand-edits. The script stays in the repo afterward as the
  historical record.
- **Backup first, in-script.** First action of every mutating script:
  `<file>.pre_<event>_backup.json`. This is the project's own safety net and is separate from any
  user-managed backup (which you never touch).
- **Verify the proposal against full raw data.** Sample-based analysis misleads: before writing a
  mechanical apply, read the complete affected dataset (a split decision made from an 8-sample can
  be wrong against the full 40-feature list).
- **Dependencies before archiving.** In an untracked working dir, grep every active script's
  literal `open()`/`json.load()` calls before moving/archiving any file; watch substring
  collisions; archive, don't delete. **Grep `open(` and `os.path.join(ROOT, "...")` as separate
  patterns, not just quoted `"*.json"`/`"*.md"` literals** — a directory dependency built via
  `os.path.join` (e.g. an audit-output folder with no file extension) won't match a
  quoted-file-literal grep and will silently look unreferenced. Confirmed as a real near-miss:
  archiving OdooDNA's working dir on filename-convention alone (`_merge_round*`/`_phase*_input`
  looking clearly disposable) also swept up `_phase5d_chain_audit_output/`, which two active
  `_gen_*.py` scripts read via `os.path.join(ROOT, "_phase5d_chain_audit_output")` — the
  regenerated reports silently lost 198 real exception annotations before the mistake was caught
  by re-running every active generator and reading its output, not just checking for a crash.

## In every mutating script (gate-check suite, printed pass/fail, assert-hard)

- **Bijection**: new ids ↔ old ids 1:1; no collisions, none dropped.
- **Conservation**: node/rd_id totals equal old + intended-delta, recomputed from the RELOADED
  output file, not from in-memory state.
- **Recount, don't increment**: every derived count (`feature_count` etc.) recomputed from a fresh
  walk of the written file.
- **Cross-axis referential integrity**: every foreign id resolves — and hierarchical consistency
  holds (a process's `primary_capability_id` must belong to its `primary_domain_id`; the two
  fields drifting apart is the classic bug).
- **Coverage exactness** for partition-type work: every input id appears exactly once across all
  outputs (no gaps, no duplicates) — checked by script BEFORE the apply script is even written.
- **Numeric id comparison**: parse the numeric suffix; `'RD-829' < 'RD-8281'` is false
  lexicographically — a real bug once.

## Agent-output handling

- **Trust structured output over text heuristics.** Merge scripts consume the agent's own category
  /verdict fields; never re-derive a classification by keyword-matching the agent's prose.
- **Flag-don't-force-fit** instructions in every clustering/classification dispatch; treat an
  agent pushing back on its own scope as signal, not noise — follow up with a corrected dispatch.
- **Windows encoding**: any script printing non-ASCII runs with `PYTHONIOENCODING=utf-8` (cp1252
  chokes on `±`, `→`, Vietnamese).
- **PARTIAL_MISMATCH is the highest-risk finding category — audit it first, and hardest.**
  Confirmed at scale on MeudsaDNA (2026-07-31): a full re-check of all 81 PARTIAL_MISMATCH findings
  (not sampled) found 40% needed a fix — wrong category (no real document was actually cited, just
  a code description mislabeled as a mismatch), wrong citation (including one outright wrong-file
  citation caught by an earlier sample-based audit), or an inference dressed as evidence (e.g. "this
  doesn't match what the component's name implies" with no real spec behind it). The category is
  structurally harder than the other two: CODE_ONLY only requires describing the code accurately;
  COVERED requires that plus confirming a doc matches; PARTIAL_MISMATCH requires BOTH steps of
  COVERED plus correctly identifying a genuine divergence — twice the failure surface, and the one
  category where a scanning agent's own pattern-matching ("this looks like it should diverge") can
  substitute for real evidence undetected. **Practical implication**: when auditing a corpus (sample
  or full), weight PARTIAL_MISMATCH findings first and hardest; when dispatching Phase 2 scanning,
  instruct agents explicitly that PARTIAL_MISMATCH requires citing the actual diverging document
  content, not just asserting a mismatch from the code's shape/naming alone.
- **LLM classification output is a draft, not a final answer — see agent-orchestration.md's
  "Multi-pass classification & reconciliation" (added v2.0.0).** Confirmed by real measurement: the
  same semantic-classification test run 3x independently agreed only 60-70% of the time. For
  judgment-heavy batches (leveling/splitting verdicts, `business_description` writing, actor-lane
  classification), run 2-3 independent passes and reconcile disagreements rather than trusting a
  single pass; record the agreement rate. Mechanical extraction (finding scanning, id assignment)
  is NOT judgment-heavy and does not need this.
- **A rule/proposition sentence must not claim MORE than its cited evidence (added v2.7.0, from
  the OdooDNA DD pilot).** "only X", "cannot", "always", "never" are STRONG claims; the evidence
  must quote the guard's actual predicate and the sentence's strength must match it. Two
  field-verified failures: a guard blocking pricelist changes only in state `'sale'` was written
  up as "can only be changed while the order is still a draft" (false — sent quotations were
  editable), and a write() that still permitted subsection→section became "display type can never
  change". Dispatch wording + the per-round strong-claim spot-check live in
  agent-orchestration.md (instruction 9 and the reconciliation section) — this class is invisible
  to structural gates because the sentence is fluent and well-formed; only comparing it against
  the quoted predicate catches it.
- **Rule-bucket audits weight `exception_flow` and `integration_rules` first (added v2.7.0).**
  The pilot showed those two buckets collect the misfiles: exception_flow attracts anything
  "notable" (features, automations, audit logging — none of which is something going WRONG), and
  integration_rules attracts internal record-to-record linkage that faces no external system.
  Audit against glossary.md's bucket litmus table + attachment litmus.
- **Near-duplicate app pairs breed citation mix-ups.** Confirmed on MeudsaDNA across two separate
  audit rounds: when a project has mirrored apps with near-identical file structure (admin-panel vs
  vendor-panel, both scanned in the same waves, both containing e.g.
  `price-list-prices-edit.tsx:22`), scanning agents repeatedly cited the RIGHT line number in the
  WRONG app — a comment/behavior that only exists in one twin gets attributed to the other. This
  isn't a one-off; it recurred independently in both the PARTIAL_MISMATCH and CODE_ONLY audit
  rounds. On any project with mirrored/near-duplicate app pairs, call this out explicitly in Phase 2
  scanning dispatch prompts ("double-check WHICH app a shared-shape file belongs to before citing
  it") and weight audits toward findings that compare or could be confused between the two twins.

## Verification of rendered output

- **Real local `http.server`, never `file://`** — preview panes silently no-op cross-page
  navigation on file URLs and you will misdiagnose it as a page bug. Kill the server afterward.
- **0 console errors** + spot-check REAL content changed as intended (e.g. the corrected "12
  months" text actually appears), not just that the page loads.
- **Language-residue gate** after any translation/content pass: recursively walk EVERY string in
  the final JSON and the rendered HTML — not just "narrative-looking" fields. For Vietnamese use
  the character class `[Ạ-ỹĐđĂăƠơƯư]`, NOT `[À-ỹ]` (the naive range false-positives on `×` U+00D7
  and friends).
- **Stray-id sweep** after remaps: every old-format id remaining in rendered output must sit under
  a known historical field (`legacy_*`, `previous_*`, `merged_from`); anything else = missed live
  field.
- **Business-readability gate (jargon-lint, added v2.0.0)** — after any Phase-4b `business_description`
  pass, run `python <skill>/scripts/check_gates.py <project-dna dir>` (added v2.1.0): it walks every
  `business_description.{what_it_does,input,process,output}` field across every Feature against THE
  authoritative banned list (which lives in that script — never re-implement a per-round variant;
  two rounds hand-writing their own regexes produced two divergent lists, which is how this rule
  got here). Same recursive-walk discipline as the Language-residue gate above — the script checks
  everything, not a sample. Any hit sends that Feature's `business_description` back for a rewrite,
  not a manual patch. The script also mechanically covers conservation counts, id uniqueness,
  dangling edges, ancestor resolution, coverage/shape, and the version-stamp staleness warning —
  run it at the end of EVERY round that touched the store, whatever the round was about.
- **Business-description coverage (added v2.0.0)** — every Feature bootstrapped under methodology
  v2.0.0+ must carry a `business_description`; a Feature missing it is an incomplete Phase-4b run,
  not silently fine. Features from PRE-v2.0.0 rounds are allowed to lack it (a recorded gap — see
  the `dna_methodology_version` field), but any Feature TOUCHED (created or updated) by a v2.0.0+
  round must have it before that round is recorded as done.

## Structural health checks (periodic — quality of the tree, not integrity of the data)

The gate-checks above verify data INTEGRITY (ids, counts, references). Separately, audit the
tree's STRUCTURE on a cadence — after bootstrap, and after any large threading/consolidation
round. Adapted from the capability-catalog framework, with its thresholds recalibrated as
**REVIEW TRIGGERS, not hard limits**: evidence-derived DNA trees legitimately run denser than
hand-authored product catalogs (the reference tree averages ~16 features/capability vs the
catalog framework's 3–8 rule) — a trigger firing means "look here", never "auto-split".

- **Overlap**: two capabilities in one domain whose features share >~30% object+action → merge
  or redraw the boundary.
- **Orphan**: a feature that fits equally under 2+ capabilities → the capability boundaries are
  wrong; fix the boundaries, never duplicate the feature.
- **Balance**: a capability >5x its siblings (by feature count or size mass) → likely
  under-decomposed; and a capability whose XL-share exceeds ~5-10% of its features → likely
  over-merged (see bootstrap-playbook's consolidation hazard). **Feature-count-outlier trigger
  (added v2.0.0)**: a capability with ≥50 features OR ≥3x the store's GLOBAL median
  features-per-capability (not just vs. its own siblings — catches whole-domain-uniform bloat a
  siblings-only comparison misses; confirmed on real data: OdooDNA has 19/67 capabilities, 28%, at
  ≥50 features, up to 291 in one capability) → re-apply glossary.md's Capability identity litmus.
- **Identity-litmus re-check (added v2.0.0)**: periodically re-run glossary.md's Domain/Capability/
  Feature identity-question table against the tree, not just at bootstrap time — a taxonomy that
  passed the litmus once can drift as findings accrete over update rounds. Triggered explicitly by
  the feature-count-outlier signal above, but worth a light pass on any large threading round too.
- **Process-axis structural health (added v2.0.0, threshold corrected v2.14.0)**: a Flow's
  rendering is split on its WIDEST STAGE, not its total Process count — §2.5's 1-5 Processes per
  Stage and §5.3's ~7 nodes per row (see diagramming.md). The old "~20-25 per Flow" was a
  home-grown number the guideline never had; it was corrected in diagramming.md at v2.12.0 and
  survived here, which mattered because this line also carried the ONLY prompt to check whether a
  Flow bundles multiple journeys — and hanging that prompt on a process count meant it never fired
  for the Flows that needed it. Measured on STELLARNet: of the 7 Flows later found to bundle
  foreign material, 5 held 9-15 Processes and never tripped the threshold.
  **That check now has its own home: glossary.md's Flow acceptance test 5 (internal coherence),
  which is run per Flow at construction time rather than waiting for a size trigger.** Keep the
  size signal for what it is actually good at — diagram readability — and read test 5 for whether
  a Flow is one journey.
  A CONTROL node
  with `decision_branches` containing fewer than 2 entries is malformed (a decision needs 2+
  business-meaningful outcomes by definition — 1 entry means it should've stayed a plain
  `controls_process_id` gate, not been promoted to a decision).
- **BPM-guideline conformance checkpoints (added v2.8.0** — see `references/bpm-alignment.md`;
  both are REVIEW TRIGGERS, never auto-mutations): a Stage holding more than ~5 Processes (or 0)
  fires the guideline's "1–5 Business Processes per Stage" check — real calibration says the rule
  is realistic (127/132 stages complied, max outlier 8), so an outlier means "look here", split
  only after human review. A Process name that isn't Verb + Business Object gets a naming flag —
  handled under the Conservative-renaming rule below, NEVER a mass rename.
- **Actor-registry hygiene (added v2.7.0)**: no two entries in the project's
  `project-dna/_actor_registry.json` (glossary.md → Actor registry) may be near-duplicates —
  check case-insensitive equality, substring containment, and synonym pairs across names AND
  aliases; and every `actors` value on every Process must resolve to a registry name. Both are
  mechanically checkable. Field-verified failure this closes: "Sales Rep" + "Salesperson" and
  "Customer (portal)" + "Portal Customer" coexisting in one flow's process records because
  `actors` was free text with no registry.
- **Object-relationship audit**: every EXTENDS points at a real base domain/object with its
  divergence point documented; two domains silently EXTENDING the same base without knowing of
  each other is a flag.
- **Implementation-variant sweep (added v2.4.0)**: for DI/interface-heavy codebases, cross-reference
  every Feature's `rd_ids` against source paths flagged during scanning as one of several
  implementations of the same interface (agent-orchestration.md's implementation-variant check).
  Any hit that was never re-verified against the real composition-root/DI-registration wiring is a
  flag — re-verify by hand, don't silently trust it. Confirmed real incident (STELLARNetDNA): a
  finding from an in-memory test-double repository, worded in generic business prose, got
  clustered into the real login Feature whose actual implementation is an unrelated external
  service. This is the highest-priority thing to check in the Phase-7b/§5b random-sample audit
  (bootstrap-playbook.md / update-playbook.md) — it's the exact failure class that motivated
  adding that phase.

## Process discipline

- **Proposal → approval → mechanical apply** for anything structural (taxonomy, renames, merges,
  deletes). Approval gates are honored even when the answer seems obvious.
- **`VERIFIED` review status is a human signature — no script or agent ever assigns it (added
  v2.8.0).** The pipeline's ceiling for any BPM information object is `DOC_CONFIRMED` (which must
  cite document + version from an `is_spec: true, scope: "project"` source). Verification binds
  to the exact reviewed content: a re-scan never invalidates it while that content is unchanged;
  a content change re-queues the object for DIFF-based re-confirmation, not a from-scratch
  review. Full invariants in `references/bpm-alignment.md` §3.
- **Conservative renaming**: audit-then-rename-HIGH-confidence-only; concrete markers (a table
  name, "CSV", a component name), not "sounds technical"; original kept as `legacy_name`.
- **Additive over destructive** whenever another dataset cross-references the ids being touched.
- **Blocked by someone else's debt? Verify in a scratch copy, flag the real fix separately
  (added v2.8.0).** A narrowly-scoped round can find the store unbuildable for a PRE-EXISTING
  reason outside its own scope (real case, STELLARNet BF-07 pilot: 162 features carried a
  legacy pre-v2.5.0 `status: "ACTIVE"` that fails the current closed-vocab gate). Do NOT widen
  your round to fix it silently, and do NOT force past the gate: prove your own changes sound
  by building against a DISPOSABLE scratch copy with only the blocker patched there, then flag
  the real fix as its own proposal/round. The unrelated debt gets its own approval trail; your
  round stays reviewable at its stated scope.
- **Record every round** (progress log + update history + memory for reusable lessons) — and in
  the publish repo: review `git status`/diff before staging, commit only what the round changed,
  never touch user backup folders, never push without a fresh explicit yes.
- **Clean up scratch/intermediate files at the end of a round — don't let them accumulate.** A
  round's `.pre_*_backup.json` snapshots and `_phaseN_*_input`/`_output` batch directories are
  disposable once that round's effect is folded into the canonical files
  (`_bc_*.json`/`_bp_*.json`/`_all_findings.json`) and recorded in the progress log. The
  `_prep_*`/`_merge_*`/`_apply_*` one-off SCRIPTS are NOT in the disposable set (aligned v2.1.0 —
  this bullet previously contradicted SKILL.md's layout note): a committed one-off script IS the
  historical record of how a mutation happened; keep it in the repo — leaving them in place round after round is exactly how a working directory grows
  to 200+ files and becomes unfit to hand to anyone. Build the keep-set using the "Dependencies
  before archiving" gate above (real script dependencies, not filename-convention guessing), move
  everything else out, then **prove nothing broke by re-running every active generator script and
  reading its actual output** (not just checking for a non-crash — a silently-empty optional input
  produces a clean exit with degraded content, exactly the near-miss recorded above). Once a
  project has a real published backup elsewhere (e.g. a git-tracked `reports/` folder holding the
  generated deliverables), the scratch sweep can delete outright instead of archiving — the
  archive-don't-delete default in the gate above is for when no such backup exists yet.
