# Project DNA — bootstrap playbook (building from scratch)

> **In kiln:** this page is tps-project-dna v2.18.1's text, verbatim. The scripts and files it names
> are that project's; [reading-note.md](reading-note.md) says what each one is in kiln, and where
> the two disagree, kiln's commands win.

The from-zero pipeline. On the reference project this produced 8,280 findings, 1,034 features and
309 processes over multiple sessions; expect the same order of effort. Phases run in order; each
ends with its gate-checks green before the next starts.

## Phase 0 — Pin the snapshot

Record every source repo's exact HEAD commit + branch + date in the progress log. All scanning below
is against these commits. Also confirm now: where reports will be published (ideally a real git
repo), and the working-language rules (e.g. chat language vs. deliverable language).

Also do this immediately, before any scanning starts — it's a one-line copy, easy to forget once
the real work begins: **copy `assets/View DNA Report.bat` from this skill folder to the project's
own root** (next to where `project-dna/` will live, NOT inside `.claude/skills/`). It's the
double-clickable launcher for the Store Explorer (see dna-store.md) — every project should get one
the moment the skill is installed, not as an afterthought once someone asks "how do I view this."

## Phase 1 — Density scan: find what's worth reading

Write a density-ranking script per source repo (backend/frontend need separate heuristics) that
walks every file and classifies CANDIDATE / SHELL / TEST / OTHER by branching/business-logic
density, ranking CANDIDATEs by density. Maintain the `ALREADY_SCANNED` ledger inside the script and
exclude ledger entries from its "unscanned candidates" output — re-running the script is then always
safe and idempotent. Keep these scripts at the working root permanently (they re-run every update
round; don't archive them).

## Phase 2 — Scan to exhaustion (rounds)

Repeat until a fresh density run reports **0 unscanned CANDIDATE files**:

1. Select the next batch of top-density unscanned files.
2. Chunk big files by line ranges (compute exact ranges first); group small files.
3. Dispatch parallel scanning agents (cheap/fast model tier is fine for volume — see
   agent-orchestration.md). Each agent reads its real chunk and returns structured findings:
   `proposition` (business language), `category` (CODE_ONLY/COVERED/PARTIAL_MISMATCH — definitions
   in glossary.md), code evidence, and ticket references when visible in `git log`.
4. Merge via a one-off `_merge_*.py` with the standard gates (quality-gates.md): backup, assign
   sequential `RD-####`, bijection/no-gaps/counts-match-recount.
5. Update `ALREADY_SCANNED`, re-run density scripts to confirm progress, log the round.

## Phase 2b — Evidence layers: infra map + DD sources (added v2.7.0)

A brand-new DNA collects ALL its evidence layers in the SAME bootstrap round the findings were
scanned in — never as a later "supplement" round bolted onto an existing DNA. As soon as Phase 2
reports 0 unscanned CANDIDATEs, run `scripts/bootstrap_infra_map.py` (service/surface/edge draft
for `_infra_map.json`), then `scripts/bootstrap_dd_sources.py` with the FULL extractor suite
(ui, db, api, err, i18n, deploy, calls — no `--only` subset on a bootstrap) against the same
Phase-0 pinned snapshot. Both are mechanical zero-LLM-token draft generators; a human reviews the
drafts before anything downstream consumes them. This is DNA COLLECTION, not DD production —
dna-store.md's "Boundary (station discipline)" note governs: downstream stations (the DD
renderer, ticket/test authors) only CONSUME the drafts and report a missing extract back as a DNA
gap, never run collection as a step of their own artifact.

- `bootstrap_infra_map.py` run against the pinned snapshot; draft reviewed (MERGE mode if a live
  `_infra_map.json` already exists).
- `bootstrap_dd_sources.py` full suite run; per-extractor record counts + the source pin recorded
  in `_PROGRESS.md` as part of THIS bootstrap round — the same round entry the findings scan
  belongs to, not a separate afterthought entry.

## Phase 3 — Taxonomy: the Domain → Capability skeleton

Do NOT derive the taxonomy bottom-up from code and stop there — code-derived taxonomies fragment
(the reference project's first attempt: 18 domains/304 capabilities; final: 9/67). The strongest
source is a **business/product-owner-authored domain list** grounded in the real UI; ask for one.
Fold cross-cutting technical concerns into exactly one PLATFORM domain. Resolve boundary disputes
in a written memo the user approves BEFORE mass mapping (proposal → approval → apply). Legacy
hand-authored business docs are naming/backbone sources, never count/completeness sources.

**Each domain in the approved taxonomy carries a declaration** (adapted from the
capability-catalog framework): its **Core Business Object** and that object's lifecycle
(create → ... → retire), 3+ items of domain-specific **vocabulary**, and an **Object
Relationship** — `EXTENDS [object] from [domain]` (inherits which attributes + adds which, with
the lifecycle divergence point named), `REFERENCES` (by id only), or `Standalone` (see glossary:
object relationships). A candidate domain that cannot name its object, lifecycle, and vocabulary
is a *grouping*, not a domain — send it back to the memo stage. EXTENDS declarations are what
stop a rebuild team from duplicating a base object where they should extend it.

## Phase 3b — Capability litmus pass (added v2.0.0)

Before mapping findings into the approved skeleton, run every proposed Capability through
glossary.md's Identity litmus tests ("What can you DO with that object?") — a Capability that's really
just the Core Business Object's name or a lifecycle state (no ability verb) gets renamed or split
here, before Phase 4 clusters thousands of findings under a wrong-shaped bucket and makes the fix
expensive. This is a naming/shape review of the SKELETON only — Phase 4 still does the real
finding-level clustering.

## Phase 4 — Cluster findings into Features

Per capability (or per domain batch): agents read the real findings assigned there and cluster them
into named Features — business-first names stating the ability/outcome (no table/component/
implementation nouns), one-paragraph descriptions, exhaustive/exclusive rd_id partition. Then a consolidation pass merges fragments (parallel batch agents fragment
naturally; consolidation is a separate deliberate step). Then t-shirt size every Feature
(S/M/L/XL by rebuild complexity, with justification). Classify each Feature on the glossary axes
(business_relevance, delivery_nature, abstraction_level, confidence). Generic UI/UX + engineering
standards go to the excluded appendix, never the business tree.

**Consolidation-pass hazard: over-merging distinct abilities that share a grounding.** When a
consolidation agent merges near-duplicate Features scattered across a capability's batches, it can
over-correct — bundling GENUINELY DISTINCT business abilities into one mega-Feature just because
they share a topic, country, or vendor (e.g. "generate the e-invoice XML" + "submit it to the tax
authority" + "track its status" + "onboard company credentials" all merged into one XL "Manage
[Country] E-Invoicing" Feature, because they're all part of the same country's mandate). This
violates Feature atomicity ("ONE deliverable business ability") even though the merge was
well-intentioned. Confirmed at scale on OdooDNA (2026-07-27): an audit across 36 consolidated
capabilities found 29/36 affected, ~4,200 findings (~16% of the corpus) sitting in over-merged
Features. **Detection**: after consolidation, grep every Feature's own `size_justification` for
admissions like "combines"/"merging" — an agent that merged distinct abilities usually says so
in its own justification text — and flag any capability where XL-sized Features exceed roughly
5-10% of its Feature count (XL should stay rare per the glossary's size calibration). **Fix**: a
follow-up split pass, one agent per batch of flagged mega-Features, given the real underlying
findings (not just the merged Feature's summary) and instructed to re-decompose into 2-5
single-ability Features, verified by an exhaustive/exclusive partition check per entry — this is
strictly additive to the consolidation step, not a redo of it.

Every clustering dispatch follows agent-orchestration.md's **non-fit discipline** (canonical
wording and full procedure live there, don't restate it): `misassigned` (belongs under a
different EXISTING capability — agent names which) is kept strictly separate from `taxonomy_gap`
(fits nothing that exists — never force-fit); taxonomy_gap flags are synthesized post-fan-out
into a taxonomy-extension proposal for the user's approval, applied mechanically per
id-schemes.md, and the freed findings re-dispatched under the new node.

**Clustering hazard: text-plausible ≠ actually-wired (added v2.4.0).** Don't cluster a finding
into a Feature on the strength of its `proposition` reading like a plausible match — verify it,
when the finding cites a class flagged as one of several implementations of the same interface
(agent-orchestration.md's implementation-variant check). Confirmed real incident (STELLARNetDNA):
a finding from an in-memory test-double `UserRepository` read exactly like generic login prose and
got clustered straight into the real login Feature, whose actual implementation is an unrelated
external Authenticator service — one grep of the codebase's own DI composition roots
(`*ProductionModuleDependencySetup.cs` vs `*InMemoryModuleDependencySetup.cs` or equivalent) would
have shown the cited class is never wired for production. **Required check** before absorbing a
flagged finding into a real Feature's evidence: locate the composition-root/DI-registration file
and confirm this concrete class is the one actually resolved for the target environment. Can't
confirm it → don't silently include it; route to `misassigned`/excluded with a note, or (if the
alternate implementation genuinely IS informative, e.g. it demonstrates intended interface
semantics) keep it but flag the Feature's evidence list so a human can judge. This is the
Phase-7b random-sample audit's number-one thing to spot-check (see that phase) — it exists
because this exact failure mode slipped through a full pipeline run undetected until a human
happened to eyeball one Feature's description against the real call graph.

## Phase 4b — Write business_description (added v2.0.0)

A SEPARATE dedicated pass, deliberately not the same pass that wrote Phase 4's technical
`description` — writing plain-business prose while still holding the source/finding detail in
working memory is exactly how technical jargon leaks in (confirmed on real Feature `DOM-PLT-01-03`
"Authenticate, Secure, and Route Inbound HTTP Requests", whose `description` mixed `ir.http`
internals, CSRF/CORS/BREACH detail directly into what should have been a business-facing summary).
For every Feature, an agent reads ONLY the already-written `description` + `name` (not the raw
findings/source again) and produces `business_description`
(`what_it_does`/`input`/`process`/`output`, glossary.md's template) — a compression/reframing task,
not a re-extraction task, mirroring diagramming.md's existing "short-label compression is its own
skill, done as its own pass" precedent. Gate-check: every `business_description` field free of the
jargon-lint's banned patterns (quality-gates.md); a Feature missing `business_description` entirely
is an incomplete Phase-4b run, not a silently-fine one.

## Phase 5 — Process axis

Design Flows → Stages → Processes from the real flows the findings/UI evidence support (16 flows on
the reference project). For each Process: trigger, actors, input/output, primary domain+capability
assignment (with reasoning), typed capability_relationships, rule buckets, status transitions,
exception flows. Then map Features ↔ Processes (`related_feature_ids`) with orphan-feature
diagnostics. Classify `process_kind` and `flow_type` last (they need the whole picture).

### Phase 5a — Business-flow synthesis (added v2.12.0, run BEFORE 5b)

**The finding corpus is a DATA flow, not a business flow.** Findings are extracted per source
file, so what the corpus actually describes is how data moves through modules. A Business Flow is
a different object — a journey a business pursues from an initiating event to an outcome — and
you cannot reach it by grouping or summarising data flows, because the grouping axis (module) is
not the journey axis. This skill has warned "business flow ≠ data flow" in prose since v2.0.0
and the warning was still followed off a cliff: it named no step, produced no artifact and had
no check, so the bottom-up habit won every time. Hence a phase of its own.

**5a is a WHOLE-INVENTORY phase. It cannot be run per capability area — doing so guarantees the
exact defect it exists to prevent.** A slice of the capability axis *is* a domain, so an agent
handed one area produces single-domain flows by construction and then fails acceptance test 2 on
work that was actually correct. (Found by the v2.12.0 field pilot: the tester followed this text
exactly, was handed one area, and reported "both primary journeys are single-domain… they only
pass because I reached into the out-of-scope listing on my own initiative". The first draft of
this phase never said the scope was global — the same class of error as the original bug: an
instruction whose structure forces the wrong answer.)

**Scale — how to run it on a large project.** The two motions below need different visibility, so
split them and only the first needs the whole picture:

| | visibility needed | grain | parallelisable |
|---|---|---|---|
| Choose the journey SET + stages (steps 1-2) | **global — every Process in the corpus** | id, name, domain, actor, one-line trigger | **no** |
| Attach evidence, find gaps (steps 3-6) | one journey | full Process detail | **yes, per journey** |

Deciding the set needs only the coarse grain, which stays affordable: ~1000 Processes at that
grain is roughly 80KB. Emit it as a flat **journey-discovery sheet** (one line per Process) so the
global view is cheap, reproducible and reviewable. Once the journey boundaries are fixed, the
detail work fans out safely because the boundary is no longer in question.

For a large or unfamiliar corpus, run step 1 as a **panel**: several agents propose journey sets
independently from the same sheet, then reconcile. Agreement is a good sign; divergence is the
useful output — it marks where the business structure is genuinely ambiguous and needs the BA,
rather than being silently settled by whichever agent happened to run.

**Direction of work: hypothesise the journey top-down, attach evidence bottom-up.** These are
two separate motions and conflating them is the whole bug.

1. **Enumerate journeys, not modules.** For each party the business serves, ask what outcome
   they are trying to reach end to end — "a patient goes from needing care to having been seen
   and billed", not "the booking module". Name each as a recognized end-to-end outcome (§5.2,
   commonly Noun-to-Noun) and sanity-check its LEVEL against the D365 Business Process Catalog
   hierarchy the guideline cites in §7 (end-to-end process → process area → business process →
   scenario). Most candidates that feel obvious will land at *business process*, not end-to-end.
2. **Lay out each journey's stages as lifecycle phases** — still no evidence yet. A stage is a
   phase of the journey ("Intake", "Fulfilment", "Settlement"), named as a noun (§5.2).
3. **Now attach the evidence.** Map the Processes derived from findings into the stages they
   serve. A journey normally consumes capabilities from SEVERAL domains — that crossing is the
   signal the axis is genuinely independent of the Capability axis.

   **A Process belongs to exactly ONE Flow — `BF-NN.S#.P#` has no second home (added v2.12.0,
   all three panels of the whole-inventory pilot hit this independently and each invented a
   different ad hoc tiebreak).** A shared service genuinely used by several journeys (a directory
   picker, a notification dispatcher, an org-hierarchy lookup) is common and not itself a
   problem — the assignment rule is what was missing, not the sharing. Assign it to the Flow
   whose JTBD it completes when performed there — "who does this Process leave satisfied, in
   this call?" — never to whichever Flow happens to be processed first. Record every OTHER
   journey that also calls it as a `related_feature_ids`-style cross-reference on the Process,
   so the relationship stays visible without duplicating the node. Do not let a shared Process's
   placement manufacture or erase a domain crossing for test 2 — that crossing must come from
   Processes that are genuinely the Flow's own.
4. **Record what the evidence does not cover.** A stage with real business meaning but no
   supporting finding is a **GAP** — the business does it outside this system (a clinician signs
   a form, an insurer approves, a courier collects). Mark it; do not delete the stage to make the
   picture tidy, and do not invent Processes to fill it. Gaps are among the most valuable output
   of this phase: they are exactly where the system does not yet serve the journey.
5. **Guard against the opposite failure.** Hypothesising top-down invites fabricating journeys the
   business does not actually run. Every journey must be either recognizable to a stakeholder or
   traceable to the published catalog, and every stage it claims must be either evidence-backed
   or explicitly marked as a gap. A journey that is neither is deleted, not kept "for symmetry".
6. **Leftovers are a finding, not a failure.** Processes fitting no journey are usually
   platform/governance capabilities — they belong to a `SUPPORTING` flow, not to a `PRIMARY`
   journey invented to house them.
7. **When the store already has a Flow structure, it is a hypothesis to test, not a given
   (added v2.14.0).** 5a on an existing store is a retrofit: the incumbent Flow set was minted
   before this methodology existed, so treat every incumbent Flow as a candidate that must pass
   the acceptance test on its own, and treat any *claim recorded in a store record* as an
   assertion to re-derive rather than a fact to inherit. On the v2.13.0 pilot a Flow's own record
   declared itself "the explicit Platform-Domain-boundary case for this round"; the claim had
   never been tested against the exemption's three conditions, and when an adjudicator finally
   ran them it failed two outright — its supposed cross-domain consumers each turned out to own
   duplicate attach/retrieve Processes of their own, which is duplication, not shared
   consumption. That Flow had also survived three full whole-inventory passes untested, because
   every panel treated it as part of the furniture. An incumbent structure earns no presumption.

### Phase 5a-recon — Panel reconciliation (added v2.13.0, runs after step 1 when 5a used a panel)

**What is mechanical here, and what is deliberately NOT.** Reconciling N independent panel
proposals splits into two halves with opposite natures, and collapsing them into one "just run a
script" step is itself a bug this section exists to head off: *detecting whether panels agree* is
pure bookkeeping over process ids — no business meaning is involved in checking whether panel G's
`BF-01` and panel I's `BF-01` contain the same 23 `P###` ids, so a script does it. *Deciding what
to do where they disagree* is a genuine business-boundary judgment (does this journey include
order-result tracking as one of its own stages, or is that a separate journey it merely hands off
to?) — no script decides that, and **critically, neither does a vote count**: 2 panels agreeing
against 1 is a prioritization signal for the mechanical step, never a verdict, because 3
independent agents can share the same blind spot as easily as they can independently converge on
the truth. Every disagreement is adjudicated by an agent reading the actual reasoning, or it goes
to the BA — there is no shortcut in between.

1. **Every panel emits a structured manifest alongside its narrative report** — the narrative
   stays what a human reads; the manifest is the only thing the mechanical step reads. Schema and
   full rationale for why it must be JSON, not the narrative parsed after the fact, are in
   `scripts/reconcile_5a.py`'s own docstring. The short version, learned the expensive way on the
   v2.12.3 field pilot: a first attempt regex-parsed the panels' own markdown for process ids, and
   3 of its 5 flagged "disagreements" turned out to be one panel's own prose mentioning ANOTHER
   flow's process id as a comparison example ("Booking has its own P014, unlike Related Links'
   P080") — text a regex cannot tell apart from a real assignment. A manifest has no prose to
   misread; re-running the same 3 panels' proposals through the schema-based script cut the
   escalation count from 5 (3 of them noise) to 2 (both real).
   **Never accept a panel's own coverage claim.** Ask each panel to verify completeness by
   counting the artifact it wrote, not by adding up its own section headings — "22+11+27+…=252"
   can only confirm a claim against itself. On the v2.13.0 pilot all three panels' prose asserted
   full coverage while all three had silently dropped the same process (below).
2. **Run `scripts/reconcile_5a.py --roster <the 5a sheet>`** over the N manifests. It unions
   processes into consensus clusters wherever a majority of panels place them together, and
   separately lists every cluster where panels disagree on the grouping (not merely the flow's
   name) — these are the ONLY items that need further work. On the pilot: 15 consensus clusters
   accepted outright, **2 grouping escalations** — roughly 1% of the corpus needed a human-grade
   decision, because three independent whole-inventory passes already agreed on the other 99%.
   **`--roster` is not optional.** Without it the script's process set is the UNION OF THE PANELS,
   which is structurally blind to anything every panel dropped — and the panels cannot catch that
   either, since each only self-reports. On the pilot exactly this happened: one process (the
   store's entire single-process Flow) appeared in none of the three manifests, every panel's
   prose still claimed 252/252, and the reconciler reported 251 as if that were the corpus. It
   surfaced only because an adjudicator went looking for something else. A process dropped by
   EVERY panel is its own escalation class — nobody placed it, so no amount of agreement covers
   it, and it goes to an adjudication agent exactly like a contested cluster does.
3. **Every escalation goes to a dedicated adjudication agent — mandatory, not majority-voted.**
   Dispatch one agent per contested cluster (not a re-run of the whole corpus): give it every
   panel's actual reasoning for that specific cluster (their prose paragraphs, not just which
   flow-id they used), and ask it to either produce a reasoned verdict — which of the proposed
   groupings is right, or a synthesis of both — or explicitly say it cannot resolve this
   confidently and route it to the BA. An agent that reads reasoning can catch what a vote count
   cannot: on the pilot's own escalations, the correct call in one case tracked with the MINORITY
   panel's argument, not the majority's raw count.
4. **Consensus clusters are not re-litigated.** Three independent panels landing on the identical
   grouping without collusion is itself the evidence that there is nothing left to adjudicate
   there — re-reviewing it would just be spending agent time to confirm what already has no
   disagreement to resolve.
5. **Gate every dossier you hand a panel (added v2.14.0).** The panels' input is itself a build
   artifact — an extract of this methodology plus an assembled evidence sheet — and a defective
   build is invisible from inside the run: the agents simply reason without the missing part and
   return confident, well-formed, wrong answers. On the v2.13.0 pilot the extract script sliced
   the methodology by HARDCODED LINE NUMBERS and shipped 18.6KB of 39.7KB, dropping the entire
   Platform-Domain boundary and its three conditions; five agents ran on it before an adjudicator
   happened to follow a cross-reference pointing "above" at a section that was not in the file.
   Use **`scripts/build_panel_dossier.py`** rather than writing the extract ad hoc — it slices by
   heading anchor, refuses to write unless every block the phase depends on is present by name,
   refuses an extract that ends mid-sentence, and (given `--sheet` + `--roster`) asserts the
   evidence sheet covers the roster exactly. Verified against the real failure: replayed over the
   truncated pilot extract it reports 7/9 required blocks and names the two missing Platform-
   exemption conditions. Its required-string list is content a panel actually depends on, not
   headings — a heading survives a truncation that eats everything under it. Extend that list
   whenever a phase grows a new load-bearing rule; an unlisted rule is an ungated rule.
   **Run `--check` immediately before dispatching panels, every time.** The content gates only
   prove the extract you BUILD is complete; they say nothing about one sitting on disk from an
   earlier run, and a stale dossier is the truncated-dossier failure with a later timestamp. This
   is not hypothetical: on the same production run a rule was added to the references *after* the
   dossier was built to settle a disagreement, and both panels and then the adjudicator reviewing
   them all read an extract that predated it — caught only because the adjudicator went looking
   for that rule by name. Amending the methodology mid-run and re-dispatching without rebuilding
   is the easiest version of this mistake to make, because everything else about the run looks
   correct.
   A panel that reports "the methodology referenced something I could not find in it" is
   reporting a build failure — re-extract and re-run that panel, do not reason over its output.

### Phase 5a-stage — Stage re-layout after a merge (added v2.14.0, runs after the restructure applies)

**A merge leaves a concatenation, not a journey, and nothing downstream notices.** Merging Flow B
into Flow A appends B's stages after A's. That is correct bookkeeping and wrong modelling: the
result is two half-journeys end to end, usually with duplicated phases — both had a "create", both
had a "delete". Every count still reconciles, every gate passes, and the store now claims a
journey nobody could walk. On the first production run this produced a 13-stage and an 11-stage
Flow whose stage lists were just the four absorbed Flows' names in a row. Budget this pass into
any restructure round; it is not optional polish.

1. **Build one dossier per affected Flow** — `scripts/apply_stage_layout.py dossiers --dna DIR`.
   With no Flow ids it targets exactly the Flows carrying `merged_from`. Add the un-merged Flows
   explicitly when their stages predate this methodology: they will be named as things a user DOES
   ("Compose & Send Mail") rather than as phases, which `check_bpm.py`'s stage-naming row measures.
2. **One agent per Flow, whole-Flow at once.** This is the same shape as 5a step 1 and for the
   same reason: the phases are a property of the whole journey, so an agent that sees only part of
   it will reproduce the seams it was given. Give it the Flow's every Process with trigger and
   output. Bind it to: a Stage is a PHASE, named as a noun phrase; an absorbed Flow does not
   automatically become a Stage (that just renames the concatenation); target §2.5's 1–5 Processes
   per Stage; every Process lands in exactly one Stage, **verified by counting the artifact it
   wrote, not by summing its own headings**.
3. **GAPs are output, not failure.** A phase the journey needs that no Process implements is
   recorded with zero Processes and a note. The first run produced four, and they are among the
   round's most decision-useful findings: a reservation journey with no way to END a reservation,
   a document journey named "to Disposition" with nothing that assigns retention. Never delete a
   needed phase to make the layout tidy, and never invent a Process to fill one.
4. **Apply and gate** — `apply --dna DIR --layouts DIR [--renumber] --apply`. **Point `--layouts`
   at a directory holding ONLY this round's layouts.** `stages_<FLOW>.json` is keyed by Flow id,
   and a renumber makes ids mean different things between rounds: after one compaction `BF-09`
   named a 50-Process document journey in the previous round's files and a 13-Process survey
   journey in this one. The exact-Process-set gate catches the mismatch, but a stale file that
   happens to still fit would be applied silently — give each round its own directory. The layout
   must cover its Flow's Process set exactly; `gap`/`gap_note` must reach the store (a reader cannot
   otherwise tell a deliberate gap from processes lost by accident); historical-provenance fields
   are exempt from both the remap and the dangling-reference audit. Then re-key every id-keyed
   **sidecar** (`sidecar --file ...`) — diagrams, overlays, anything not derived from the
   write-models, because nothing rebuilds those and they will point at ids that no longer exist.
5. **Bundle a renumber into the same cascade if you want one.** Compacting Flow ids after a merge
   is a departure from id-schemes.md's "gaps from history are fine, never re-packed" and needs the
   owner's call — but if it is wanted, `--renumber` does it in the same pass. Run separately it
   costs a second full remap, a second provenance era, and a second sidecar re-key, and each extra
   era is what makes the NEXT repair harder (see id-schemes.md on multi-era provenance).

Output of 5a: the flow/stage skeleton with its gaps. Only then run 5b (below) to fill in Process
detail. Validate the skeleton with glossary.md's **Flow acceptance test** and `check_bpm.py`'s
flow-scope rows before minting `BF-` ids.

### Phase 5b — Process detail

**Do NOT discover Flows by walking the evidence (corrected v2.12.0 — this is the single most
consequential structural decision in the whole method, and one sentence of guidance was not
enough).** Findings are extracted per source file, so they are organized by MODULE. Reading them
for "what flows exist" reliably yields one flow per module — and because the Capability axis was
already built from the same evidence in Phase 4, the two axes come out as the same partition
under different names. Measured on STELLARNet: **26/26 flows confined to a single capability
domain**, 23/26 named verb-first (the Process naming convention), 9/26 with a single stage, and
only 9 of 416 edges crossing a domain boundary. Every one of those flows was built "correctly"
by this instruction. The Process axis has to be an INDEPENDENT decomposition — a journey consumes
many capabilities — otherwise the second axis carries no information the first one didn't.

Derive Flows from JOURNEYS instead, then attach the evidence:
1. Ask who the business serves and what outcome each of them is trying to reach end to end
   (initiating event → meaningful business outcome), across whatever modules that takes.
2. Name each candidate as a recognized end-to-end outcome (§5.2, commonly Noun-to-Noun);
   cross-check the level against the D365 Business Process Catalog hierarchy cited in the
   guideline's §7 (end-to-end process → process area → business process → scenario).
3. Only then place the evidence-derived Processes into the journey's Stages. A Process that fits
   no journey is a signal — either a journey is missing, or the item is a supporting/platform
   capability that belongs to a `SUPPORTING` flow, not a `PRIMARY` one.
4. Run glossary.md's **Flow acceptance test** on every candidate before minting a `BF-` id, and
   `check_bpm.py`'s flow-scope rows (single-domain / single-stage / verb-first name) over the
   finished set. A flow that fails is a mis-levelled Process; demote it rather than keep a `BF-`
   id that a reader will trust as a journey.

**Required design fields (added v2.0.0)** — glossary.md's Process-axis additions are not optional
metadata, they're how a Process's own shape gets checked while it's still cheap to fix: every
Process gets a `jtbd` (`when`/`want`/`so_that`) and must pass the boundary litmus ("has the actor
received the full value yet?") before being finalized as its own node — a candidate that fails
folds into the Process it's actually a Task of. Every `process_kind=CONTROL` node with 2+
business-meaningful outcomes gets real `decision_branches` + `decision_maker`, not a single
`controls_process_id`; a CONTROL with genuinely one path stays as-is (it's a validation gate, not a
decision). If a Flow's finished Process count lands above the diagramming.md review threshold,
that's a signal to re-examine the Flow's JTBD scope now — before Phase 7 renders a diagram no one
can read — not something to discover only after the fact.

**Actors and rule buckets are closed-vocabulary work (added v2.7.0, from the OdooDNA DD pilot).**
Before the first enrichment batch goes out, seed `project-dna/_actor_registry.json` (glossary.md →
Actor registry) from the approved taxonomy's known roles; every dispatch then carries the current
registry plus glossary.md's bucket litmus table, attachment litmus, and rule-sentence bar
verbatim (agent-orchestration.md instructions 8–9 — including the claim-strength rule: strong
claims quote the guard's predicate, and the sentence may not claim more than it). Batches reuse
registry names or return `proposed_actors` for the orchestrator to near-duplicate-check and merge
between waves — free-text actor names written inline are defects. After the fan-out, run the
strong-claim spot-check and weight the bucket audit toward `exception_flow`/`integration_rules`
(quality-gates.md). All four rules exist because one field pilot produced all four failure
classes at once: duplicate actors, misfiled buckets, subject-less code-leaning rule prose, and
guards over-strengthened into factually wrong claims.

**Business flow ≠ data flow — model the former, not the latter.** A Process is a business-meaningful
action a real actor takes to move the business forward (approve, submit, confirm, ship, reconcile,
notify, decide), never a technical data-movement/ETL step ("sync table A to table B", "transform XML
payload"). Even fully automated Processes must be framed by their business purpose and outcome, not
their data mechanics — "Auto-Post Recurring Journal Entries at Period Close", not "copy account.move
rows on cron schedule." `input`/`output` describe business state/objects (an approved invoice, a
reconciled bank statement), never raw data schemas. A Business Flow is also USUALLY BROADER than any
single data flow: it typically spans several distinct technical/data sub-flows plus real external
interventions (a customer approving a quote, a vendor confirming a PO, a bank settling a payment, a
tax authority validating a submission). Don't narrow a flow down to its internal system steps alone —
give external parties their own `actors` entries, and when an external response gates progress, model
it as its own (often CONTROL-kind) Process rather than collapsing it into a generic automated step.

## Phase 6 — Ticket & evidence links

Derive issue-tracker + commit URLs from the source repos' own `git remote -v` and `git log` — never
guess URL shapes. Rule-id matching must be domain-scoped (short rule ids collide across domains).
Render as clickable ticket→commit links on findings, rules, Features, Processes.

## Phase 7 — Views (reports)

Build the report set per views.md: capability map, process map, coverage matrix, front-door system
map, raw reverse-discovery view, MD renditions. One standalone generator per page reading the live
JSON — a page's numbers are computed at generation time, never hardcoded (hand-crafted pages that
must hardcode data get listed as manual-update items in the update playbook).

## Phase 7b — Random-sample audit (added v2.4.0)

The pipeline's own quality gates catch structural problems (bijection, dangling ids, coverage) but
not semantic ones — a finding can be real, correctly formatted, and still attached to the wrong
Feature because it read as plausible during clustering (see Phase 4's clustering hazard above).
This phase mechanizes the spot-check that would otherwise only happen if a human got lucky:

1. **Sample size**: `min(30, max(10, 2% of the round's touched findings))` — scales with round
   size rather than being a fixed number.
2. **Sampling scope**: findings actually created/touched by THIS round (the whole new corpus on a
   first bootstrap; just the diff on an update round — don't re-audit the whole historic corpus
   every round, that's what the FIRST audit was for).
3. **Blind re-verification**: dispatch fresh-context agents — give each ONLY the sampled finding's
   raw source citation (re-fetch the actual lines, don't trust the stored `evidence` text alone)
   and the FULL text of the Feature/Process it's currently attached to. Do NOT give the agent the
   original scanning/clustering agent's reasoning — that's exactly the bias being tested for.
4. **Verdict, one of four**: `PASS` (evidence genuinely supports this attachment) /
   `FAIL-MISASSIGNED` (evidence is real but belongs elsewhere — name where) / `FAIL-FABRICATED`
   (evidence doesn't support the proposition at all) / `FLAG-AMBIGUOUS` (genuinely unclear, needs
   a human call). Every verdict must explicitly answer the implementation-variant question too:
   is the cited class confirmed production-wired, or unverified/a known alternate implementation?
5. **Threshold**: compute the error rate (`FAIL-* / sampled`). Above ~10% → treat as the same
   signal a human noticing one bad case should trigger: a full sweep of everything sharing the
   failure's root cause (e.g. every finding from the same implementation-variant class) is
   required before the round can be recorded as done, not just fixing the sampled instances.
   Below threshold → fix the sampled failures individually, round proceeds to Phase 8.
6. **Record it**: the round's `_update_history.json` entry gets an `audit_sample` field
   (`{sampled, pass, fail, error_rate}`); `_PROGRESS.md` narrates what was checked and what (if
   anything) triggered a full sweep. See update-playbook.md for the equivalent step on incremental
   rounds (same mechanism, narrower scope).

## Phase 7c — Triage the flags (added v2.14.0)

**Every audit in this methodology ends by refusing to act, and until now none of them said what
happens next.** That refusal is correct — `check_bpm.py` says "REVIEW FLAGS, never renames", the
structural-health checks say "a trigger firing means look here, never auto-split", a failed
identity litmus is "a REVIEW TRIGGER, not an automatic mutation". Counted across the reference
files there are eight such statements and exactly one of them names a next step. The result on a
real round: hundreds of flags produced, and every one of them left in a different place — an
agent's markdown, a `bpm_review.note`, a `primary_assignment_reasoning` sentence, the operator's
own chat. None of it anywhere the NEXT round is guaranteed to read. This is the same defect
`id_history` and `carried_from` fixed for data, unfixed for findings.

Phase 7b already has the one complete loop (sample → four verdicts → error-rate threshold →
root-cause sweep → `audit_sample` on the round entry). Phase 7c gives every OTHER flag the same
treatment, and it deliberately does not require anyone to fix anything — only to DECIDE.

1. **Collect every flag the round produced into `project-dna/_findings_ledger.json`**, one entry
   each: `id` (`FND-YYYY-MM-DD-NN`), `source` (which check or agent raised it), `kind`, `subject`
   (the node ids it concerns), `claim` (one sentence), `evidence`, `raised_by` (round id).
   Sources include, at minimum: `check_bpm.py` review flags, `check_gates.py` failures,
   `sweep_ids.py` dead references, structural-health triggers, identity-litmus failures, the
   benchmark's judged flags, and anything an adjudication agent flagged rather than decided.
2. **Give each a status**, and this is the whole point of the phase: `OPEN` (not yet looked at) /
   `ACCEPTED` (real, will be fixed — cite the round that will do it) / `REJECTED` (looked at,
   judged not a defect — the reason is mandatory and is the valuable part) / `DEFERRED` (real but
   not now — record the condition that should reopen it) / `SETTLED` (fixed — cite the settling
   round id, gate-checked the same way a `DEBT-` entry cites its `UPD-`).
3. **A round does not close with `OPEN` entries.** Not "does not close with unfixed flags" —
   unfixed is fine and often right. It closes when every flag has been *classified*. This is the
   only gate here, and it is what stops a flag being silently outlived by the round that raised it.
4. **Record a recurring flag ONCE, at the level it recurs.** Nine instances of one missing
   capability is one finding with nine subjects, not nine findings — the fragmented form is how a
   product-level fact gets read as nine local defects and fixed nine wrong ways. (Same rule
   glossary.md applies to a recurring test-2 seam; a pilot adjudication had to correct a panel for
   splitting one finding into ten orphan entries.)
5. **A REJECTED flag is evidence, not deletion.** Keep it with its reason: the next round's
   identical flag is then answered instead of re-litigated, and a rejection that turns out wrong is
   traceable to who made it and on what grounds.

Why a separate ledger rather than `_debt_ledger.json`: a Debt's closed vocab
(`HOTFIX`/`MAP_OUTDATED`/`UNRULED_AREA`) is about code-versus-map divergence and cannot express
"this Flow may bundle two journeys". Same lifecycle machinery, different question — and a
`SETTLED` finding may well cite the `DEBT-` or `UPD-` entry that resolved it.

## Phase 8 — Record the baseline

Create `_update_history.json` with the `INITIAL_BUILD` entry (`UPD-` id, pinned commits, corpus
totals by category, feature/process totals), generate the update-history report, write the progress
log, save the taxonomy + lessons to memory, and commit the published reports.
