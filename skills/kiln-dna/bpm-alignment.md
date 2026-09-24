# Project DNA — BPM-guideline alignment (QMS Business Flow & Business Process Modeling)

> **In kiln:** this page is tps-project-dna v2.18.1's text, verbatim. The scripts and files it names
> are that project's; [reading-note.md](reading-note.md) says what each one is in kiln, and where
> the two disagree, kiln's commands win.

How the DNA's Process axis aligns with the QMS **"Business Flow and Business Process Modeling
Guideline"** (Confluence page 132645468, authored by the BA side, in team review as of Aug 2026),
and — the part this reference exists for — WHICH pieces of that guideline's required information
the reverse-engineering pipeline can produce mechanically vs. which require BA/business input,
plus the review-status layer that tracks every such piece to human sign-off.

Position source: the owner's review comment on that page (2026-08-21, comment 132645855). The
guideline itself is still under review; if its final approved text changes a mapping below, update
THIS file in the same round that acknowledges the change — never let the two silently diverge.

## 1. Concept & ID mapping (QMS ↔ DNA)

The two models describe the same three levels. The DNA's internal ids stay authoritative for the
pipeline; the guideline's ids attach as OPTIONAL cross-reference metadata fields — the same
standing rule as the GitLab-guideline reconciliation (proposals/2026-08-19, §10): **never build a
crosswalk/translation layer between id schemes; add a field on the node instead** (the
`ticket_refs`/`matched_rule_id` pattern).

| QMS guideline concept | QMS id | DNA node | Cross-ref field (optional, additive) |
|---|---|---|---|
| Business Flow (end-to-end journey, "Order to Cash") | `BF-{FLOW}` e.g. `BF-O2C` | Flow `BF-NN` | `bpm_id` (+ `bpm_mnemonic`, e.g. `"O2C"`) |
| Business Stage (lifecycle phase, visual Group) | `BS-{FLOW}-{NN}` | Stage `BF-NN.S#` | `bpm_id` |
| Business Process (collapsed sub-process, one outcome) | `BP-{DOMAIN}-{NNN}` | Process `BF-NN.S#.P#` | `bpm_id` |
| Gateway / business decision | `{PROCESS-ID}-D{NN}` — PROCESS-ID is the QMS `BP-…` id, not the DNA id (pilot-settled: `BP-BKG-010-D01`), stored as `gateway_bpm_id` in the node's `ext` | CONTROL node with `decision_branches` | `ext.gateway_bpm_id` |
| Lane (responsibility boundary within a Pool) | lane id `L##` | diagram lane (from actor registry taxonomy) | lane table in the Process's BPM metadata (§3) |
| Pool (independent participant/organization) | named Pool | `EXTERNAL` actors / `EXTERNAL` services | Process-level, like lanes — the guideline's own §5.4 puts "Participant/Pool" in each Business Process's required info, NOT on the Flow (a first draft of this table had it Flow-level; the BF-07 pilot flagged the inconsistency) |

Semantic notes that make the mapping honest, not just name-matching:

- The guideline's Stage is a **visual container, never an executable node** — the DNA already
  treats Stages this way (transitions connect Processes; a Stage has entry/exit criteria, not
  edges). No change needed; stated here so nobody "fixes" it.
- The guideline's Gateway rules (a decision is a short business QUESTION; every outgoing branch
  labeled; branches mutually exclusive and covering) are ALREADY the DNA's `decision_branches`
  contract (glossary.md — 2+ entries, `outcome_label` per branch, demote single-outcome checks).
  The one addition: when drafting a decision from code, the technical condition must be
  **TRANSFORMED into a business question** ("Order Ready for Fulfillment?"), never copied as a
  code predicate — the same bar the rule-sentence rules already set for bucket entries.
  Naming follows the guideline's §5.2 split: a DECISION node (2+ branches) is NAMED as a short
  business question ("Requested Facility Time Available?", question polarity matching its own
  branch labels; multi-way decisions take a which-question), while Verb + Business Object
  applies only to non-decision processes — `check_bpm.py` checks the two populations
  separately. Renaming an existing decision to question form is a normal
  proposal → approval → mechanical apply round (id stable, old name to `legacy_name`).
- The guideline's User Task vs Service Task distinction maps to what the code already tells us:
  screen/button-driven behavior vs scheduled jobs/server actions (Feature-level
  `delivery_nature: USER_FACING` vs `SYSTEM_AUTOMATION`; per-step, the same signal read off the
  finding's source shape). **At Process grain, the sanctioned signal is the node's own `actors`
  list** (whole-project redraft pilot, 2026-08-26 — independently converged on by multiple
  agents as the only signal actually available at that grain, and already how
  `check_bpm.py`'s task-typing check itself works): any human/role actor present → User Task;
  `actors == ["System"]` (or equivalent, no human) → Service Task. A process whose OWN trigger
  genuinely mixes both (a human enables a setting that a system then executes automatically —
  cited example retired by a later restructure; the shape recurs, so describing it generically
  here rather than by process id) is a real, not-yet-modeled edge case — draft `task_kind`
  AI_SUGGESTED from the dominant actor anyway and flag it in the object's notes rather than
  leaving it MISSING; splitting such a process into separate User/Service steps is a future
  round's judgment call, not a task_kind-drafting one.
- A CONTROL node WITHOUT `decision_branches` is a plain validation gate (glossary.md: "simple
  validation gates with exactly one path... are not decisions"), NOT a decision — it does NOT
  get the decision-node naming/task_kind exemption below; review it exactly like any ordinary
  process. Only a node carrying 2+ `decision_branches` is a real decision.
- An individual end-user interacting with the system from outside the organization (a Patient
  booking an appointment, or an anonymous/unauthenticated public visitor on a public-facing
  screen, analogous to the guideline's own "Customer" example) is a valid Pool candidate — the
  guideline's Pool examples (Customer, Supplier, Carrier, Bank) are not limited to B2B
  counterparties. Draft `pools` AI_SUGGESTED wherever such an actor appears as a process's actor,
  same as any other external party. **NOT a Pool**: another internal Flow/Process of the SAME
  system triggering this one (e.g. a Survey process fired by a Booking workflow) — that is a
  Process-axis relationship (`TRIGGERS`, `related_feature_ids`), not an independent organization;
  the two concepts share the word "external" but operate at different scopes (external to this
  Process vs. external to the organization) and must not be conflated.

## 2. Derivability contract — what the pipeline may draft vs. what only a BA can supply

Every BPM information object the guideline requires falls in exactly one group. This is the
load-bearing table: it tells a dispatching session what to AUTOMATE, what to DRAFT-then-queue for
confirmation, and what to leave honestly `MISSING` rather than fabricate.

### Group 1 — derivable from source code (pipeline may produce mechanically or as agent drafts)

| # | Information object | DNA mechanism |
|---|---|---|
| 1 | Process trigger, inputs/outputs; Stage entry/exit criteria; Flow trigger/outcome | already extracted (Process `trigger`/`input`/`output`, `jtbd`; Stage criteria) |
| 2 | "Verb + Business Object" process naming | conformance CHECK on existing names — non-conforming names get a review flag, NEVER a mass rename (Conservative-renaming rule, quality-gates.md) |
| 3 | Business decisions | branching/data-flow logic is the raw source, TRANSFORMED per §1's gateway note into `decision_branches` with business-labeled, mutually exclusive branches |
| 4 | User Task vs Service Task | code shows automated (cron/`@Scheduled`/server actions) vs human-operated (screens, buttons) — §1's mapping |
| 5 | "1–5 Business Processes per Stage" rule (guideline §2.5) | mechanically checkable review trigger (quality-gates.md → structural health; real calibration: 127/132 stages comply, max outlier 8 — STELLARNet 76/81, max outlier 13). **This is THE size rule**: diagramming.md carried a competing home-grown "~20-25 processes per Flow" threshold until v2.12.0. Being at flow level it fired on conformant flows and missed over-full stages; §2.5 (per stage) plus §5.3 (~7 nodes per visual row) replace it |
| 6 | BPMN 2.0 XML export | mechanical render from the store — Flow → Level 0, Process → Level 1 (§4; diagramming.md Pattern 4). `.bpmn` is the diagram source; PNG/SVG only published views |
| 7 | Stage naming — noun / lifecycle-phase, §2.5 (the OPPOSITE convention from row 2's Process naming) | conformance CHECK on existing names — non-conforming names get a review flag, NEVER a mass rename (same Conservative-renaming rule as row 2) |
| 8 | Process JTBD single-job boundary — a name/trigger that joins 2+ verbs with "and"/"or" is a WEAK signal, 25% measured precision | heuristic CHECK on name/trigger conjunctions — flags a CANDIDATE for human/judge review, never a defect count; every flag needs an individual P1.1 judgment pass before any split, and most resolve to "leave as one process" — splitting is real content surgery (id/reference remapping), applied only after that judgment, never automatic |
| 9 | Rule-sentence language (glossary rule-sentence bar: named subject, no raw identifiers, no implementation vocabulary) — mechanizes the CONCRETE-MARKER half only | marker scan over all 8 rule buckets + decision_maker + branch conditions: implementation-vocab word list, CamelCase/snake_case identifiers, numeric sentinels/code lists, gerund openers. Flag-only, precision NOT yet measured; known FP classes documented in `check_bpm.py` (product names are CamelCase; domain words like a mail/comment "thread" are business language). Added after the first full-coverage judged benchmark put P3 at mean 2.61/5 with these exact marker classes recurring in judge notes |
| 10 | Converging gateway — a decision whose EVERY branch targets the same next process decides nothing the flow can see | 100% mechanical: fires only when all `decision_branches` carry a `target_process_id` and they're identical (a `terminal_outcome` branch is real divergence and exempts). A hit is a P1-boundary review trigger (fold the check into the target process's rules, or model a real divergence) — found live on the reference benchmark, confirmed by 3 independent judges |
| 11 | UI-prep process name — a name centering a screen/page/modal/dialog artifact is usually UI preparation modeled as a standalone process | name-pattern flag, review-only: judges consistently fail these on P1 ("screen ready" is not a business rest state); but a legitimate job CAN mention a screen, so every flag needs the boundary judgment, never an auto-merge |
| 12 | Pattern-2 diagram conformance — a per-process activity flow authored under a since-retired recipe is stale content nothing else flags | mechanical DSL scan of `_bp_process_diagrams.json` (retired technical lanes, rule-bucket node ids, a `decision_branches` card with no diamond, dead-end nodes). A hit means the diagram predates diagramming.md's current Pattern 2 recipe and needs RE-AUTHORING — a re-draft round is content surgery (agent judgment), never a mechanical DSL rewrite. Added after 350/350 diagrams on a real project sat two versions on the retired recipe until a judged benchmark (P6 floor) rediscovered what this scan catches on any run |

Rows 7 and 8 were added after `tps-quality-benchmark`'s first judged pass over STELLARNetDNA
(2026-08-27): the mechanical layer had never checked Stage naming or process JTBD-boundary at all
(only Process Verb+Object naming, row 2), so both defect classes were invisible until an expensive
judge fan-out surfaced them — 68/81 stages and 89/207 non-decision processes flagged, both
FAR above outlier-rate (contrast row 5's real 127/132 calibration). Verified as a real,
skill-level gap, not project-specific noise, via a small-sample fix-and-rejudge round on BF-03 (4
stages), which also caught a SECOND sub-pattern the first version of the check missed:

- Round 1 fix (verb → noun/lifecycle-phase, e.g. "Author, Publish, and Manage Topics" →
  "Topic Authoring & Lifecycle") took judged S1.1 from 0/4 to only 2/4 — the judge independently
  flagged the remaining two ("Topic Authoring & Lifecycle", "Access & Permission Control") for a
  DIFFERENT reason: joining two concepts with "&" still reads as a catch-all bundle, not one
  coherent phase, even when both halves are nouns.
- `stage_name_verdict()` was extended with that second signal (any "&"/" and " in a stage name is
  now flagged, not just an imperative-verb opener) and the two remaining names were tightened to
  single coherent phrases ("Topic Lifecycle", "Access Control"). Round-2 rejudge: S1.1 landed at
  3/4. Both mechanical signals are now validated as real, judge-agreeing improvements.
- The one residual failure (BF-03.S2 "Topic Engagement", unchanged across both rounds) is a THIRD
  defect class with no lexical marker at all: a clean generic noun bundling two distinct activity
  types (comment authoring/moderation vs. passive consumption) under one catch-all label. This is
  judge-only territory — a mechanical rule that flags "generic-sounding nouns" would be unworkably
  noisy — so it is deliberately left undetected by row 7, same discipline as P3/P6 in the wider
  judged pass. See `_PROGRESS.md`'s 2026-08-27 entry for the full before/after.

This is why row 7's heuristic checks for BOTH signals, not just the verb-opener one — a
naming fix that only addresses the first-token verb misses the more common "&"-bundle case in
this store (48/81 stage names contain "&"/"and"). With both signals validated, the fix was
extended to the rest of the store: 25 independent subagents (one per remaining flagged flow, each
reading only its own flow's full reader-view dossier) proposed replacement names, applied
centrally with `legacy_name` preserved. Whole-store result: **74/81 (91%) conformant**, up from
10/81. The remaining 7 flags are a confirmed false-positive class in the check itself — ambiguous
verb/noun English words ("Schedule", "Search", "Order", "Group", "File", "Link") used correctly as
a noun-phrase head ("Schedule Configuration", "File Attachment") rather than an imperative verb;
`stage_name_verdict()`'s docstring now documents this so a reviewer reads the full name before
acting on a flag, rather than renaming real content just to silence the checker.

Row 8 (bundling) started as a CHECK-only round — splitting a flagged process is real content
surgery (id renumbering, reference remapping, the same class of work as §5's flow-scope
restructure) and was deliberately left for a dedicated round rather than folded into the naming
fix, so the two defect classes wouldn't get conflated into one apply step. That dedicated round
ran later the same day (2026-08-27), per explicit user direction to fan out per-flow like row 7's
extension:

- **Pilot** (BF-01.S4.P2, "Move Mail to Trash and Permanently Delete Messages"): split into two
  processes (reversible soft-delete vs. irreversible permanent-delete). Two independent judges
  scored both halves 9/9 on P1 (boundary integrity)/P2 (outcome clarity)/P4 (naming) — the split
  methodology validated before any wider extension.
- **Extension**: 21 independent subagents (one per flow with row-8 flags), each JUDGING every
  flagged process in its flow against the real P1.1 criterion ("states exactly ONE job, no second
  independent job bundled in") before drafting anything — conservative by instruction: when
  unsure, leave it as one process. Of **88 flagged processes, only 22 (25%) were confirmed real
  bundles** and split (one into 4 processes, one into 3, the rest 2-way); the other 66 were
  genuine false positives, overwhelmingly one of two patterns: "and"/"or" joining sub-steps of ONE
  coherent act ("Search and Filter"), or "or" naming an alternate object/input type ("file or
  directory") rather than a second job. One case (BF-26.S1.P1, "Attach and Retrieve Files for
  Other Business Records") was left UNSPLIT and flagged for BA review rather than resolved either
  way: the source record already carried a prior `bpm_review` note judging the bundling "likely
  intentional," and this round's independent JTBD analysis disagreed — a genuine dispute between
  two judgment passes, not something to silently decide.
- Applied centrally (never per-agent writes): 45 new process records replacing 21 old ones (net
  +24), `split_from` provenance kept, `bpm_id`/id minted from the next available number per
  domain/stage. Two processes were REFERENCED by other nodes (`controls_process_id`/
  `decision_branches`/edges) — both retargeted correctly, including one CROSS-FLOW case
  (BF-28.S1.P1's gate, which controlled BF-20.S1.P1, was repointed to the "Update" half, not the
  "View" half, since a write-availability gate has no reason to guard a read). One retarget
  (BF-04.S2.P8's "this occurrence and after" branch) is a judgment call flagged `_retarget_note`
  in the data itself for BA confirmation, not asserted as certain.
- Whole-store gates re-ran clean (bijection, no dangling refs) after every step; `manifest.json`
  counts updated (227→252 processes, 374→416 edges) — never left stale.
- **Measured precision (25%) is now baked into the skill**, not just this round's finding:
  `bundling_flags()`'s docstring and `check_bpm.py`'s report output both carry the number and the
  two dominant false-positive patterns, so a future run never reports "N processes flagged" as if
  N were a defect count — every flag still needs the same individual P1.1 judgment pass this round
  used, and most will resolve to "leave as one process."
- Two independent spot-checks on new splits at the larger scale (BF-02.S3.P4 "Stop..." and
  BF-09.S1.P11 "Quick-Create...", one of the 4-way split's quarters) both confirmed P1
  boundary-integrity held; one caught a real but minor naming defect (redundant near-synonym
  phrasing carried over unedited from the bundled original, e.g. "Stop a Notice to Pause Its
  Distribution") on the Stop/Delete notice pair, fixed directly (`Stop a Notice's Distribution` /
  `Permanently Delete a Notice`) since it was independently confirmed, not assumed.

### Group 2 — requires BA/business input (system may DRAFT where noted; a human confirms)

| # | Information object | What code gives us / draft mechanism |
|---|---|---|
| 1 | Business owner (flow) / Process owner (process) — two SEPARATE objects, one per node level | nothing — organizational fact; human-supplied (`MISSING` until then) |
| 2 | Business Function lanes + Lane Selection Basis | code shows security groups/roles — close but NOT real functions/departments. **Corrected v2.12.0: do NOT draft lanes by mapping actor strings onto the lane axis.** §3.4 puts actors on tasks as *performers*; the lane axis is Business Function (§3.5 Rule 1). Actor strings are therefore evidence for a function TAXONOMY the BA confirms (`Hospital Staff`, `Front-desk/Scheduling Staff` → one `Patient Services` function, say), not lane names themselves. Drafting lanes = actors mechanically produces a mixed-granularity axis that §3.5 Rule 6 forbids — measured: 97 distinct lane labels over 252 diagrams on STELLARNet, every one of them authored "correctly" per the old recipe |
| 3 | Pools — independent participants (Customer, Carrier, Bank…) | integrations reveal endpoints (`EXTERNAL` services/actors); "which party is an independent organization" is BA judgment — system drafts, BA confirms. **Note (v2.12.0): a process always has at least ONE pool** — §3.1 lists "Participant or Pool" as a defining attribute and §3.4 states "Company is a Pool, not the first lane". So `pools` is never legitimately empty: the owning organization is the default pool (name it, e.g. the hospital operator), and the BA's judgment is about ADDITIONAL independent participants. Treating `pools` as wholly optional left it `MISSING` on 252/252 processes while the real gap was only the extra participants. **An external party named only in prose (`integration_rules`/`trigger` text, e.g. "calls the Reveal enrichment service") and never listed in `actors`** is still a legitimate pool candidate — the actors list is where the pool-drafting GUIDANCE anchors its examples, not a gate on what counts. Draft it `AI_SUGGESTED` the same as an actor-listed external party, but note explicitly that the anchor was prose, not `actors`, so the BA reviewing it knows why (2026-09-01, OdooDNA pilot) |
| 4 | Recognized end-to-end Flow names + mnemonics (Order to Cash / O2C) | product-owner decision; system only PROPOSES from the Flow's own trigger→outcome |
| 5 | Flow purpose & scope | trigger/outcome are minable; "why this journey exists" must be written by the BA |
| 6 | Related Business Flows / Source or reference | only the BA knows which business documents are the source |

The split is per information OBJECT, not per node: one Process typically carries Group-1 facts
(trigger, decisions, task kinds) alongside Group-2 facts (owner, lane basis) at different review
states simultaneously.

## 3. Review-status layer (per information object, human sign-off)

Every reviewable information object carries a `review_status` — a CLOSED vocabulary forming
review queues over one shared model.

**Which objects are reviewable — and the CLOSED key vocabulary** (added after the BF-07 pilot,
where two gaps surfaced: §2's row "trigger, inputs/outputs; Stage criteria; Flow trigger/outcome"
bundles three node levels into one row, and free-form keys would let two drafting rounds name the
same concept differently with nothing to catch the drift). `bpm_review` keys come from this list
and no other — extending it is a dictionary change (glossary rules apply):

| Key | On | From §2 |
|---|---|---|
| `trigger_outcome` | flow | Group 1 #1 (flow slice) |
| `entry_exit_criteria` | stage | Group 1 #1 (stage slice) |
| `trigger_io` | process | Group 1 #1 (process slice) |
| `naming` | process | Group 1 #2 |
| `business_decisions` | process (decision nodes only) | Group 1 #3 |
| `task_kind` | process | Group 1 #4 |
| `business_owner` | flow | Group 2 #1 (flow slice) |
| `process_owner` | process | Group 2 #1 (process slice) |
| `lanes` | process | Group 2 #2 (lane set + Lane Selection Basis together) |
| `pools` | process | Group 2 #3 |
| `flow_name_mnemonic` | flow | Group 2 #4 |
| `purpose_scope` | flow | Group 2 #5 |
| `related_flows_sources` | flow | Group 2 #6 |

NOT reviewable (pilot-settled): Group 1 #5 (the stage-size rule), #6 (BPMN export), #7 (stage
naming), #8 (JTBD bundling), #9 (rule-sentence language), #10 (converging gateway), #11
(UI-prep name), and #12 (diagram conformance) are all MECHANICAL CHECKPOINTS, not information a BA signs off — `check_bpm.py` owns
them; putting them in `bpm_review` would queue a human to "review" what a script re-derives every
run. This was under-stated through v2.16.1 (only #5/#6 were named, even though #7-11 were added to
Group 1 later as the same kind of heuristic flag-only check) — a 2026-09-01 draft-round pilot on
OdooDNA correctly read the *spirit* of the rule but, finding no key for these five, invented an
unauthorized `mechanical_flags` array to carry them forward per node. Don't: a draft round reports
these five via `check_bpm.py`'s own output (already does, unconditionally, every run), never via a
per-node field on the drafted object.

Decision-node scoping (BF-08 pilot-settled — the table alone left both ambiguous): on a node
with 2+ `decision_branches`, OMIT ONLY TWO KEYS and no others — `naming` (decisions are named
as questions and judged by the question-form check inside `business_decisions`, not
Verb+Object — matching `check_bpm.py`'s population split) and `task_kind` (a gateway is not a
Task; who decides is already carried by `decision_maker`, and duplicating it as a task-kind
judgment invites the two fields to disagree). Every OTHER process-level key still applies
normally — `trigger_io`, `process_owner`, `lanes`, `pools` are not naming/task-kind concepts and
carry no such conflict; a decision node needs an owner and a lane exactly like any other process.
`business_decisions` is `naming`'s and `task_kind`'s REPLACEMENT on a decision node, not a
signal to drop the rest of the process-level set — a wording a second independent agent
(BF-08 whole-project redraft, 2026-08-26) read the narrower, correct way but flagged as
genuinely ambiguous on the words alone; clarified here rather than left to keep guessing right.

| Status | Meaning | Reviewer action |
|---|---|---|
| `MISSING` | not derivable from code, not found in any doc — awaiting BA input | provide it |
| `AI_SUGGESTED` | system-drafted from source code, no corroborating doc yet | full review |
| `DOC_CONFIRMED` | draft cross-checked and matched against a BA document — MUST cite document + version | spot-check |
| `VERIFIED` | confirmed by BA/PM — reviewer + timestamp recorded | — |

Invariants (the rules that make the layer trustworthy):

1. **`VERIFIED` is a human signature — no script or agent ever assigns it.** Same spirit as
   "LLM classification output is a draft" (Core Principle 9), made structural: the pipeline's
   ceiling is `DOC_CONFIRMED`.
2. **Verification binds to the exact reviewed content.** Store the signed-off content verbatim
   (`reviewed_content`) beside the signature. Re-scanning the source does NOT invalidate
   `VERIFIED` while that content is unchanged; only when the reviewed content itself changes does
   the object re-enter the queue — and the reviewer then re-confirms against a **DIFF of the
   previous sign-off**, never re-reviews from scratch. `reviewed_content` is RESERVED for this
   exact purpose — a `VERIFIED` (or `DOC_CONFIRMED`) binding — never a place to park a draft
   round's own rationale; that belongs in `value`/`note` below (multiple redraft-round agents
   reached for `reviewed_content` before `value`/`note` existed — the field names now make the
   distinction unambiguous).
3. **`DOC_CONFIRMED` eligibility reuses the store's existing spec rule**: only an
   `evidence_sources` entry with `is_spec: true` and `scope: "project"` can confirm (dna-store.md
   — the same rule that gates a finding's `COVERED`). A `scope: "platform"` vendor doc never
   confirms anything.
4. **Code ↔ doc contradiction is a priority-arbitration flag for the BA**, not something either
   side silently wins — this is usually where the most value is (either the doc is outdated, or
   the system misread the code). Kin to the finding category `PARTIAL_MISMATCH` (and inherits its
   audit-first-and-hardest discipline), but at the BPM-object grain.
5. **Orthogonal to the existing lifecycles.** `review_status` is about human sign-off of BPM
   information; it is NOT the Feature `status: PLANNED` lifecycle (a reservation), and NOT the
   finding `category` (documentation coverage of one observed behavior). Never merge the
   vocabularies.

Physical shape (PROVISIONAL until the first field pilot — schema-after-data, the same discipline
as `_dd_sources/`): an optional `bpm_review` map on the Flow/Stage/Process record, keyed by the
object names in §2's tables, each value
`{"status": ..., "value": ..., "note": ..., "reviewer": ..., "at": ..., "doc": {"src": ...,
"ref": ..., "version": ...}, "reviewed_content": ...}`.

**`value` and `note` (whole-project redraft pilot, 2026-08-26 — 4+ independent agents hit this
gap the same way before it was named)**: `status` alone records THAT a judgment happened, not
WHAT was judged — a real gap once agents started drafting content beyond a yes/no (which task
kind, which pool candidate, what mnemonic and why, whether a name conforms). `value` carries the
actual drafted content as free text (`"User Task"`, `"AceReserve — external booking system"`,
`"BPA — proposed from trigger/outcome"`); `note` carries a flagged ambiguity or edge case worth a
reviewer's attention. Both optional, additive, never gated on shape beyond being present when the
object needs them — a status-only object (e.g. a plain presence check with nothing more to say)
is still valid. `task_kind`'s canonical `value` vocabulary is the guideline's own BPMN terms,
`"User Task"` / `"Service Task"` — not the Feature-level `delivery_nature` enum (a related but
distinct concept at a different grain, §1's mapping note). Near-duplicate `pools` candidates
across sibling processes (the same external system named two slightly different ways, e.g.
"External Authentication Service" vs "Authenticator Service") are expected pre-registry noise —
reconciled at BA-confirmation time, the same near-duplicate handling the actor registry already
does for lanes; not a drafting error to avoid.

Additive, registered as CORE fields in `build_dna_store.py`
(v2.8.0, alongside `bpm_id`/`bpm_mnemonic` — core, not `ext`, so the explorer can render badges
and queues; the v2.7.1 surface-promotion precedent), no store schema bump. The shared
`assets/explorer.html` renders the layer: worst-pending-status badge on flow/stage/process list
rows (same visibility rule as the PLANNED badge), a per-object sign-off table in the detail
panel, and a queue-count summary on the Process-axis root. Hard `check_gates.py` enforcement
(closed vocab; VERIFIED requires reviewer+at; DOC_CONFIRMED requires doc citation) is
DELIBERATELY deferred until that pilot lands, matching how the rule-sentence bar was introduced.

## 4. BPMN 2.0 export mapping (mechanical, from the store)

Target: `.bpmn` (BPMN 2.0 XML) as the editable diagram source per the guideline's §5.3 — a pure
render over already-classified fields, zero agent judgment at render time (diagramming.md's core
principle; the recipe lives there as Pattern 4, exporter script NOT yet built — see §6).

| DNA source | BPMN Level 0 (one file per Flow) | BPMN Level 1 (one file per Process) |
|---|---|---|
| Flow trigger / outcome | Start Event / End Event | — |
| Stage | `Group` (visual container, ordered) | referenced as parent only |
| Process | collapsed Sub-Process, sequence-flow chained in stage/process order | the process itself |
| `decision_branches` | major gateways only (materially changing the end-to-end path — a decision whose branches all CONVERGE on the same target process is by definition not one; real case BF-08's date-filter rule, a legitimate Level-1 decision with zero Level-0 fork) | Exclusive Gateway, one labeled outgoing flow per branch; `terminal_outcome` branches → End Events; converging-branch decisions render here (Level 1) only |
| `controls_process_id` (plain gate) | omitted | validation step, not a gateway |
| rule-bucket steps / task kinds | omitted (overview level) | User Task vs Service Task per §1's mapping |
| confirmed lanes (§2 Group-2 #2) | omitted unless BA declared them essential | `laneSet`, one lane per confirmed entry |
| transitions | UNLABELED except gateway exits (guideline §2.5) | labeled only on gateway exits / ambiguity |

Node ids inside the XML use the DNA id (with `bpm_id` echoed as the display name prefix when
present), so a `.bpmn` file stays greppable back into the store.

`related_flows_sources` vs. `split_from`/`merged_from` (whole-project redraft pilot — 3
independent agents flagged the same non-issue): a flow's own `split_from`/`merged_from`
provenance (this round's flow-scope restructure — DNA-internal structural lineage) is NOT what
`related_flows_sources` means. That key is Group 2 #6 — a BA's knowledge of which OTHER
business journeys and SOURCE DOCUMENTS this one relates to, something only a human has. Keep
`related_flows_sources` `MISSING` regardless of `split_from`/`merged_from` being present; nothing
is lost by not promoting it — the structural lineage is already captured on the node in its own
field and remains fully queryable there.

Two operational rules the BF-07 pilot settled:

- **Group 2 splits two ways, and the review floor differs.** Objects with NO draft mechanism
  (owners, purpose & scope, related flows/sources) can only ever be `MISSING` after a draft
  round. Objects the system may DRAFT for confirmation (lanes, pools, flow names) legitimately
  reach `AI_SUGGESTED`. An audit that treats all of Group 2 as "must be MISSING" is wrong.
- **Lane drafting requires the actor registry.** If `_actor_registry.json` doesn't exist yet,
  mark `lanes` MISSING rather than drafting from raw free-text actors — ungoverned actor
  strings are exactly the near-duplicate failure the registry exists to prevent (the pilot's
  flow carried "Patient" vs "Patient (status recipient)" as separate strings). Building the
  registry first is the unblocking move, not a fancier lane heuristic.
  - **A registry that EXISTS but doesn't yet cover every actor in this flow** (a real, not
    hypothetical, case: OdooDNA's registry covers 19 of 124 distinct actor strings corpus-wide,
    2026-08-31) is a different state from "no registry at all" and the rule above doesn't
    resolve it on its own. Settled 2026-09-01, OdooDNA flow-scope pilot: mark `lanes` `MISSING`
    for the WHOLE process the instant any one of its actors is unregistered under any name or
    alias — never draft from "the registered subset only." A lane set built from a partial actor
    picture is exactly the mixed-granularity failure §3.5 Rule 6 already forbids, just introduced
    a different way; there is no version of "half-drafted lanes" that is safe to hand a BA for
    confirmation.
  - **A process whose only actor is `System (automated)` (or an equivalent no-human-performer
    string) is not a lane-axis question at all.** §3.4/§3.5's lane concept is Business Function —
    which department a human performer sits in; a Service Task has no performer to place. Mark
    `lanes` `MISSING` for such a process with a `note` saying why (not a gap to fill later — a
    structurally inapplicable field), rather than leaving a reviewer to wonder whether the
    drafting step was simply skipped.

## 5. Adoption playbook — bringing an EXISTING DNA project onto this layer

The repeatable sequence for retrofitting a project that already has a built Process axis
(validated end-to-end on STELLARNetDNA, 2026-08-26 — 20 flows / 81 stages / 227 processes;
expect to re-run it on many similar projects). Steps are ordered by what each one would
invalidate if done later:

1. **Unblock the store.** Rebuild + `check_gates.py` must PASS first. A pre-existing debt
   outside your scope (real case: 162 legacy pre-v2.5.0 `status: "ACTIVE"` features) gets the
   scratch-copy escape valve (quality-gates.md) and its own approved fix — never widen your
   round silently. Update the project's `methodology_version` stamp when the round runs under
   new rules.
2. **Baseline conformance audit** — `scripts/check_bpm.py` over the whole store: stage-rule
   outliers, naming flags, decision-question gaps, Group-1 presence, Group-2 absences. This is
   the round's before-picture; keep the JSON.
3. **Flow-scope preliminary check** — BEFORE minting any BPM id, judge whether the flows
   themselves are scoped as real end-to-end journeys (module-shaped flows are the usual
   suspect). Mechanical prep: one standardized input (per-flow trigger/outcome/stages/process
   JTBDs/domain mix + cross-flow edge signals — note an EMPTY cross-flow edge set is weak
   evidence, extraction may never have captured them). Judgment: 2+ BLIND independent passes
   (Core Principle 9), reconciled; verdicts OK / MERGE_WITH / SPLIT / RESCOPE + flow_type
   check. Any restructure goes proposal → approval → apply BEFORE step 5 — ids minted onto a
   tree about to be reshaped are wasted work.
4. **Pay user-approved mechanical conformance debt** — e.g. decision renames to question form
   (one-off scripts, `legacy_name` kept, question polarity matched to real branch labels).
5. **Pilot 1–2 flows via an INDEPENDENT subagent** given only this skill text — deliberately
   don't restate the invariants in the brief; whether they're honored from the text alone IS
   the test. Verify with a separately-written checker. Harvest its ambiguity report into spec
   fixes (that is a primary deliverable, not a failure). The pilot's own output is the SAME
   `_bpm_drafts/BF-NN.json` shape step 6 produces (proposed mnemonic, per-node `bpm_review` maps
   keyed exactly per §3's table, task kinds, pools) — this step's own text only ever pointed at
   step 6's description of that shape, which a 2026-09-01 pilot flagged as leaving the file
   format feel unspecified until read carefully enough to notice; stated explicitly here so a
   pilot brief never has to guess it.
6. **Whole-project parallel redraft** — wipe any flow-scoped sample layer first (its ids are
   only locally valid), then one agent per flow IN PARALLEL producing JUDGMENT-ONLY draft
   files (`_bpm_drafts/BF-NN.json`: proposed mnemonic, per-node review maps, task kinds,
   pools) — agents never touch the write-model; 20 writers on one JSON is corruption. A single
   deterministic merge assigns EVERY id centrally (`BF-{MNEM}` / `BS-{MNEM}-NN` /
   domain-scoped `BP-{DOM}-NNN` over all flows / `-D{NN}`), gates hard (coverage exactly-once,
   closed-vocab keys per level, statuses MISSING/AI_SUGGESTED only, mnemonic uniqueness).
   Central assignment removes the per-flow number-reservation problem by construction.
7. **Close the round** — rebuild, `check_gates.py`, re-run `check_bpm.py` (before/after
   deltas), independent verifier pass, and record ONE consolidated round entry in
   `_PROGRESS.md`/update history covering all of the adoption round's mutations (pilots,
   renames, wipe, redraft — Core Principle 7 wants the round recorded; it does not want one
   ledger entry per intermediate script, and the BF-07/BF-08 pilots deliberately deferred
   bookkeeping to exactly this step), then hand the review queues to the BA (explorer badges).

## 6. Deliberately deferred (recorded so it isn't silently forgotten)

- **The exporter script itself** (`render_bpmn.py` or equivalent) — the mapping above is agreed;
  building and field-validating the XML writer is its own round, same staging as every other
  renderer (verify on real data before claiming it works).
- **Hard gates for `review_status`** — documented invariants first, script enforcement after the
  first pilot (see §3).
- **Store collections for BPM metadata** — `bpm_id`/`bpm_mnemonic`/`bpm_review` ride as optional
  fields on existing nodes; no new JSONL file until real volume justifies one.
- **A per-project `BP-{DOMAIN}-{NNN}` reservation ledger.** The QMS Business-Process id is
  DOMAIN-scoped while drafting happens flow-by-flow, so two flows sharing a domain can mint
  colliding numbers (BF-07's `BP-BKG-001…016` are PROVISIONAL: DOM-BKG also backs processes in
  BF-08). Until a ledger exists, every flow-scoped draft must mark its `bpm_id`s provisional and
  the second flow in a shared domain must reconcile before either set is cited externally.
