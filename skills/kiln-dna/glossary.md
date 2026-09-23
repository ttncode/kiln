# Project DNA — glossary & classification dictionary

> **In kiln:** this page is tps-project-dna v2.18.1's text, verbatim. The scripts and files it names
> are that project's; [reading-note.md](reading-note.md) says what each one is in kiln, and where
> the two disagree, kiln's commands win.

The shared dictionary every agent in the pipeline must use. Enum values are closed sets: never
invent a new value mid-task — extend this dictionary first (with the user's sign-off), then use it.
Escape hatch (v2.1.0) for a gap discovered mid-round when stopping for sign-off would block an
approved apply: use a clearly-marked PROVISIONAL value (record a `*_note` field beside it naming it
provisional), flag it in the round entry and the progress log, and propose the dictionary extension
in the same round's wrap-up — the provisional value is not final until the extension is accepted.
Distributions in parentheses are from the Tradom reference project, useful as calibration priors.

## Layer 1 — Evidence corpus

**Finding** — the atomic unit of evidence: one business-meaningful behavior observed in source code.
Fields: `rd_id`, `module` (file), `proposition` (one-sentence business statement of what the code
does), `category`, `evidence` (code-level justification), optional `matched_rule_id`/`domains`.
A finding states what the code DOES, in business language — not how it's implemented.

**Finding `category`** — the finding's relationship to existing documentation/spec:
- `CODE_ONLY` — behavior exists in code but appears in no document. The most valuable category:
  it is undocumented business logic. (Tradom: ~45%)
- `COVERED` — behavior exists in code and matches what documents already say. Still recorded — it
  is the evidence link that makes the documented claim verifiable. (~41%)
- `PARTIAL_MISMATCH` — documented, but the code diverges from the document (different threshold,
  extra condition, changed flow). Each one is a real doc-debt item. (~14%)

**CANDIDATE / SHELL / OTHER / TEST** — density-scan classification of source files.
`CANDIDATE` = has enough branching/business logic to be worth scanning; `SHELL` = thin
controller/DTO/pass-through; `TEST` = test code; `OTHER` = config/generated/etc. Only CANDIDATE
files get scanned; the classification itself is heuristic (branch density), re-checked when a
file's content changes.

**ALREADY_SCANNED ledger** — the set of files whose findings are already in the corpus. Maintained
inside the density-scan scripts; updated every round; the loop is closed when a fresh density run
reports 0 unscanned CANDIDATE files.

## Layer 2 — Capability axis (Domain → Capability → Feature)

**Domain** — a top-level business area, ideally from a business/product-owner-authored taxonomy
(8–10 domains is the sweet spot; code-derived taxonomies fragment into too many). Carries a `type`:
- `CORE` — the business's reason to exist (Tradom: 5 of 9)
- `GOVERNANCE` — approval/workflow/audit control over the core
- `SUPPORTING` — needed but not differentiating (reporting, administration)
- `PLATFORM` — cross-cutting technical operations the business domains run on (keep exactly ONE
  such domain so the business domains stay clean)

**Capability** — a named ability inside a domain ("Hedge Linkage", "Exposure Capture");
noun-phrase ability names ([object] + [ability noun] — how both the real tree and the absorbed
capability-catalog convention name them), business-first, no implementation nouns.

**Capability `business_description`** (added v2.2.0) — the PM/BA-facing layer at Capability
level, DELIBERATELY a different 4-field shape from the Feature one: a Feature is one demoable
value so Input→Process→Output fits; a Capability is an ABILITY spanning many features, with no
single I/O. Its four fields answer the Capability's own identity question instead:
- **`what_you_can_do`** — the ability stated in business terms, 1-2 sentences (the direct answer
  to "what can you DO with that object?").
- **`who_uses_it`** — the business actors/roles that exercise this ability.
- **`business_outcome`** — what the business gets from having it / what stops working without it
  (the reason this node exists).
- **`boundary`** — what is explicitly NOT this capability, naming the sibling capability ids that
  own each neighboring concern. This is the anti-bloat device: a capability whose boundary cannot
  be written crisply is a mini-Domain in disguise (the exact failure the Identity litmus and the
  feature-count-outlier signal catch) — writing it down makes the litmus permanent instead of
  audit-time-only.
Same jargon-lint rules as the Feature layer (`scripts/check_gates.py` is the arbiter); no field
enumerates child features (that's the feature list's job — no data duplication).

An empty capability (0 features) is kept, not deleted, with a `gap_status`:
- `TRUE_GAP` — the business expects this ability and the product genuinely lacks it
- `GRANULARITY_OVERLAP` — content lives under a sibling capability
- `NOT_APPLICABLE` — infrastructure-level concern outside the scan's scope

**Feature** — a cluster of findings describing one deliverable ability. Carries `rd_ids` (its
evidence), `size`, and the classification fields below. The finding→Feature relation is exhaustive
and exclusive: every non-excluded finding belongs to exactly one Feature.

**Feature has TWO description layers — never collapse them into one** (added v2.0.0, after review
feedback that Feature prose was reading as technical source analysis, not business capability):
- **`business_description`** — the PRIMARY, PM/BA-facing layer. A structured object, not free
  prose:
  - `what_it_does` — one to two sentences, the product/business value, zero implementation nouns.
  - `input` — the data or event that goes in.
  - `process` — the key business-level transformation (not the implementation — no controller,
    session, ORM-model, or table names).
  - `output` — the observable result or value produced.
  - **Jargon-lint litmus**: would a PM/BA who never opened the code recognize every noun in this
    field as business vocabulary? Banned patterns: dotted technical identifiers (`ir.http`,
    `res.partner`), and words like controller/endpoint/session/token/middleware/ORM/database
    table/query — if the real behavior needs one of these to explain WHY, that belongs in
    `description` below, not here. The AUTHORITATIVE machine-checkable banned list lives in
    `scripts/check_gates.py` (added v2.1.0) — run it rather than re-inventing a per-round
    variant; this paragraph describes the intent, the script is the arbiter.
  - Worked example (real feature, before/after) — before: *"The platform's front-door
    request-handling layer (ir.http base controller) governing how every inbound request is
    authenticated, secured, and routed to business logic: four route authentication modes (user,
    bearer token, public, none)..."* — after: `what_it_does`: "Protects web and integration access
    to the system's services." / `input`: "A request from a user, browser, or external system." /
    `process`: "Identifies the requester, validates security and access conditions, then routes
    permitted requests to the appropriate service." / `output`: "Authorized requests reach the
    intended service; unauthorized or unsafe requests are rejected."
- **`description`** — the existing free-prose field, kept exactly as before, RELABELED in every
  rendered view as "How it works" / technical analysis. Still real and still useful — implementation
  detail, source-grounded reasoning, the "why" behind the business behavior — just never the primary
  thing a PM/BA reads first. Additive, not destructive: no existing `description` content is ever
  deleted or trimmed for this change.
A Feature is incomplete without `business_description` once bootstrapped under v2.0.0+ (see
bootstrap-playbook.md Phase 4b and quality-gates.md's business-readability gate); Features
bootstrapped under earlier methodology versions may lack it until a future round backfills them —
that's a recorded gap, not a silent one (see the versioning section below).

**`size`** — T-shirt sizing by REBUILD complexity (what it would cost to re-implement the behavior
from this description), not by code line count:
- `S` — a single isolated rule/validation/display behavior; days. (~40%)
- `M` — a multi-rule behavior with state or several screens/services touched; ~1–2 weeks. (~46%)
- `L` — a complex behavior spanning workflows/services with significant edge-case logic. (~13%)
- `XL` — subsystem-scale; should be rare — if many features are XL, they are under-decomposed. (<1%)
Every size carries a `size_justification`.

Size doubles as the **agent-supervision routing signal** when coding agents do the implementation
(one shared convention, so every skill that dispatches work reads it the same way):
`S` → delegate whole to an agent, light human review · `M` → agent implements, human reviews
against the ACs · `L` → a human decomposes FIRST, agents take the parts (handing an agent a whole
L-sized workflow in one shot reliably produces hard-to-verify code) · `XL` → not assigned to any
agent — XL means decomposition isn't finished, and decomposition is human work.

**`business_relevance`** — `CORE` (directly delivers the domain's business outcome) vs `ENABLING`
(necessary support: configuration, plumbing with business meaning). Roughly half/half is healthy.

**`delivery_nature`** — how the behavior reaches the world:
`USER_FACING` (a human operates it) / `SYSTEM_AUTOMATION` (jobs, calculations, auto-processing) /
`CONTROL` (validation, locking, permission, eligibility gating) / `INTEGRATION` (external systems).

**`abstraction_level`** — `BUSINESS_FEATURE` (states a business outcome) vs `TECHNICAL_REALIZATION`
(a technical satellite of a named business feature; must carry `realizes_feature_id` pointing to it).

**`classification_confidence`** — `HIGH`/`MEDIUM`/`LOW`: the classifier's own confidence in the
placement/classification, kept honest so reviews can prioritize LOW/MEDIUM.

**Feature `status` — the PLANNED lifecycle (added v2.5.0, LIVE).** Closed vocab: exactly one
non-absent value, `PLANNED`. A PLANNED feature is a RESERVATION, not evidence-backed fact: a
CONFIRMED intake round (`tps-quantification-intake`) reserved the id, and
`scripts/apply_intake.py` — the one mechanical write path — inserted the stub with empty
`rd_ids`, an `intake_id` tracing back to the reserving round, and (optionally) a
`business_description` carrying ONLY `what_it_does` (the to-be sentence from intake). From that
moment the id is real and citable (AC, PR, review), but the map says "promised", not "proven".
The scan round that finds the promised code CLEARS it: attach the real `rd_ids`, REMOVE the
`status` field entirely (absent = evidence-backed; there is no "CONFIRMED" value), and fill the
remaining `business_description` keys (see update-playbook.md § 4b). Scan-born features never
carry PLANNED. Gate-enforced (builder + check_gates): status closed vocab; PLANNED ⇒ empty
`rd_ids`; every PLANNED feature traces to an intake round's `proposed_id`; the
`business_description` 4-key completeness gate exempts PLANNED features until they clear.

**Excluded catalogs** — generic UI/UX patterns and engineering standards are real findings but NOT
business capabilities; they live in a separate excluded appendix with a `disposition`, never in the
business tree, and never silently deleted (their rd_ids still count in conservation checks).

### Identity litmus tests (added v2.0.0, reuses `tps-quantification-intake`'s litmus-table style)

Every level in the Capability axis must answer ONE identity question. A name that doesn't answer
its level's question — even if it reads fine on its own — is a sign the node is placed at the wrong
level. Apply top-down when in doubt (does it pass as a Capability before considering Domain).

| Level | Identity question | Passes when | Fails when |
|---|---|---|---|
| Domain | "What does it manage?" | Resolves to ONE Core Business Object with its own lifecycle/vocabulary | Bundles 2+ objects that can be added, dropped, or evolved independently of each other (real example: `Sales & CRM` bundled Lead/Opportunity, Quotation/Sales Order, POS Transaction, Loyalty Program, and Delivery Carrier — five independent-lifecycle objects in one Domain) |
| Capability | "What can you DO with that object?" | The name is an ability/verb-phrase — [object] + [ability noun] | The name is just the object or a lifecycle state, no ability (real example: `Quotations & Sales Orders`, 106 features — object+state, not an ability; acts like a mini-Domain, not a Capability) |
| Feature | "Specifically how, demonstrating what value?" | Independently testable/demoable end-to-end value on its own | It's really one rule/step inside a larger deliverable (real example: `Auto-Assign Salesperson to New Orders` — a single defaulting rule, too small to stand alone; belongs as a `business_rule` inside a Feature like "Create Sales Order and Establish Ownership") |

A failed litmus is a REVIEW TRIGGER, not an automatic mutation — write it up as a split/merge/rename
proposal per Core Principle 4 (proposal → approval → mechanical apply), the same discipline as any
other structural change.

**Platform-Domain boundary** — the one exception to "every Domain manages a business object": a
Feature belongs in the Platform domain ONLY if ALL three hold:
1. No single owning business object with its own lifecycle (reuses the intake skill's OI-1 test).
2. Consumed by 2+ otherwise-unrelated business domains (reuses OI-2).
3. Removing it removes no business capability, only a technical delivery guarantee (uptime,
   security posture, cross-cutting infra) — the business still "wants" the same things, just less
   safely/reliably.
A Feature that sounds technical but fails #2 (only one business domain actually uses it) stays in
that business domain — Platform is a boundary, not a catch-all bucket for anything that mentions a
technical noun.

**Feature-count-outlier signal** — a Capability with ≥50 features, OR ≥3x the store's global
median features-per-capability (catches whole-store bloat a siblings-only comparison would miss),
is a REVIEW TRIGGER: re-apply the Capability litmus with fresh eyes — it may genuinely be one broad
ability with many rules (rare), or (far more often in practice) it's several abilities that never
got split. Not an auto-split — a capability can legitimately have many features if it truly answers
one ability question. See quality-gates.md's "Balance" check for how this is computed mechanically.

## Layer 3 — Process axis (Flow → Stage → Process)

**Business Process — formal definition (added v2.0.0)**: an end-to-end chain of work organized
around ONE job an actor needs to complete, in which people and systems coordinate from a trigger to
a business outcome. Identity question: "Which end-to-end chain of work, creating what value, for whom?"
(What end-to-end chain of work, creating what value, for whom?) A Process node that can't answer
this in one sentence is mis-scoped — see the boundary litmus below.

**Business Flow** (`BF-NN`) — an end-to-end journey with a trigger and an outcome. `flow_type`:
`PRIMARY` (realizes one of the business's core processes) / `SUPPORTING` (platform/governance
journeys). **Stage** (`BF-NN.S#`) — a phase inside a flow with entry/exit criteria.
**Process** (`BF-NN.S#.P#`) — one actor-performable unit of work with trigger/input/output/actors.

**`flow_type` is relative to the PRODUCT, not to "the business" in the abstract (corrected
v2.12.0).** The binary reads naturally for an operating company (Order to Cash is obviously
PRIMARY, password reset is obviously SUPPORTING) and reads wrong for a product/platform whose own
purpose IS a supporting business function — an HR system's "Joiner to Leaver" or an IT system's
"Contract to Go-Live" are core to what the product does, not incidental to it, even though they
would be SUPPORTING inside the operating company that BUYS the product. All three v2.12.0 pilot
panels hit this on STELLARNet (a hospital staff-portal vendor) and none could place their
correctly-derived HR/IT-lifecycle journeys without contradicting one reading or the other.
**Ask instead: is this journey why the product exists, or something the product needs in order
to exist?** `PRIMARY` = the former (what a customer buys the product to do — for a staff portal,
that includes running staff HR/IT lifecycles, because serving those IS the product). `SUPPORTING`
= the latter (platform/governance the product needs to run itself: access control plumbing,
generic settings, cross-cutting configuration) — narrower than "anything HR/IT-shaped."

**Flow acceptance test (added v2.12.0 — a Flow that fails these is a mis-levelled Process).**
"End-to-end journey" was the whole definition until now, and it proved far too weak to hold the
level: on STELLARNet all 26 flows came out as one-module feature areas and nothing caught it.
The QMS guideline's own tests, applied at construction time:
1. **Crosses stages** — §2.1 "normally crosses multiple Business Stages". A one-stage Flow is
   almost always a Process wearing a Flow's id (STELLARNet: 9/26, two of them a single Process).
2. **Crosses business functions** — §2.1 "may involve multiple business functions, systems or
   external participants". Mechanically: a Flow whose Processes all carry the same
   `primary_domain_id` is a module, not a journey. STELLARNet: **26/26 flows sat inside a single
   domain**, i.e. the Process axis was a 1:1 relabelling of the Capability axis, which destroys
   the point of having two axes — they are meant to CROSS (a journey consumes many capabilities),
   not mirror each other.

   **A single-domain result has TWO possible causes — check both before demoting (added by the
   v2.12.0 whole-inventory pilot, panel of 3, all three independently reached for "the taxonomy
   is the other suspect").** (a) the Flow is really a Process wearing a Flow id — demote it; or
   (b) the domain is genuinely well-formed (passes Phase 3's Core-Object/lifecycle/vocabulary
   test) AND the journey is single-domain because the SYSTEM does not yet implement the
   cross-functional step a real version of this journey would have (no outbound notification, no
   downstream competency/billing record, no reminder to a non-respondent). Confirmed on
   STELLARNet: `DOM-FIL`, `DOM-SCH`, `DOM-LRN`, `DOM-SVY` all pass Phase 3's domain-identity test
   cleanly (real core object + lifecycle + vocabulary, not a grouping) while their journeys stay
   single-domain — and each carries GAPS (Phase 5a step 4) that are exactly the missing
   cross-functional pieces. That is a genuine finding the method exists to surface, not a
   modelling defect; forcing a demotion here would suppress it.
   **This resolution presupposes tests 1, 3 and 4 already passed — it is never a substitute
   for them (added v2.13.0, from a real adjudicated disagreement).** The four-way table below
   decides what to do with a candidate ALREADY established as its own Flow that happens to sit
   inside one domain; it does not decide whether something should be its own Flow at all. On the
   v2.12.3 pilot, one panel reached for this table's boundary-litmus branch ("multiple JTBDs →
   verdict 4 → keep as its own Flow") to justify MINTING a new Flow for a 5-process cluster that
   two other panels correctly folded into an existing Flow as one of its Stages — an adjudicating
   agent found the panel had never run test 4's stakeholder discriminator at all, and the
   candidate's own chosen name failed test 3 (verb-first, not Noun-to-Noun) on inspection. A
   Stage can perfectly well hold several Processes with distinct JTBDs; JTBD-count inside a
   cluster answers "how many Processes does this need", never "is this a Flow or a Stage of one".
   If a name reads verb-first (test 3) or no stakeholder would say the business "runs" it (test
   4), stop — this is a Stage, and the four-way table below does not apply to it at all.

   **"This is a Stage" is only half a verdict — name the host Flow, or escalate (added v2.14.0,
   found independently by both panels of the first full production run).** The exit above and the
   table's own demotion branch between them cover demoting to a *Process*; neither says what to do
   with a coherent multi-Process cluster that is plainly not its own journey. Both panels hit this
   on every demotion they made — "every demotion I needed a verdict the table does not contain" —
   and improvised. So, when tests 3/4 send a candidate out:
   - **Name the surviving Flow it becomes a Stage of, and say why that Flow is its home** — the
     Flow whose outcome the cluster's work advances. A demotion without a stated host is not a
     verdict, it is a deferral.
   - **A demoted cluster may become MORE THAN ONE Stage** of its host where its own internal
     phases are real; it is not compressed into one Stage merely because it arrived as one node.
   - **If no surviving Flow is a credible host, that is an escalation, not a licence to keep it
     as a Flow.** This is the case worth catching: a cluster nobody can house is usually either a
     journey whose host has not been recognised yet, or evidence the candidate set is wrong
     upstream. On the production run, one panel kept four channel-shaped Flows (Mail, Notice,
     Discussion, plus a second document lifecycle) precisely because no host existed, and said so
     — the honest move, but it must be recorded as an open BA question, not silently as a keep.
   - A demoted cluster's own `flow_type` is discarded, not inherited: it is now part of its host's
     journey and takes the host's type.

   **Four-way resolution for a Flow that fails test 2 — run the branches in this order (added
   v2.12.1, extended with the fourth verdict and the Platform exemption by the v2.12.2
   whole-inventory pilot, and with the mid-size seam guidance by the v2.12.3
   whole-inventory pilot).** First check whether the domain is exempt: a Flow confined to the
   **Platform domain** (glossary's own Platform-Domain boundary, above — deliberately object-less
   by design) never runs the Core-Object test at all; it is single-domain by construction and
   that is not a defect to resolve. For every other domain, run Phase 3's domain-identity test on
   the ONE domain the Flow sits in:
   - **Fails** (no real core object/lifecycle/vocabulary) → the domain is a grouping, not a Flow
     problem — send the domain back to the Phase 3 memo, Flow stays provisional.
   - **Passes, and the Flow has one or more recorded GAPS** that would cross a domain if
     filled → **keep the Flow, flag "single-domain, gaps recorded"**, cite the gaps.
   - **Passes, no gap, and the Flow's own Process count sits inside the boundary litmus for
     ONE Process** (a single actor-performable unit, one JTBD, one rest state) → the Flow really
     is a Process; demote it.
   - **Passes, no gap, but the Flow's Process count clearly fails the boundary litmus for ONE
     Process** (many distinct JTBDs, many stages, 10+ Processes) → **keep the Flow**, single
     domain and no gap notwithstanding; flag "large single-domain Flow, boundary-litmus
     conflict" and route it to the BA rather than picking a side. Demoting it would produce an
     absurd single Process node standing in for a genuinely multi-stage journey — worse than the
     mis-level the test exists to catch. (Found by the v2.12.2 pilot: independently on
     STELLARNet's Mail area (15-16 Processes) and two other 12-14-Process clusters, three
     separate agents hit this exact gap in the 3-verdict table and each improvised a different
     way past it — "the rule just relocates the divergence risk rather than closing it" — which
     is the same failure shape as leaving a mandatory check without a runnable test.)
     **The mid-size zone (roughly 2-9 Processes, 2-4 JTBDs) is genuinely ambiguous, not a gap in
     the wording** (v2.12.3 — a THIRD pilot's two independent agents both stalled in exactly this
     band with "no worked example on either side"). Do not force a bright line where the boundary
     litmus itself is doing real work: apply it directly rather than by Process count — "has the
     actor received the full value they needed, even if nothing else runs next?" tested at EACH
     internal seam. A seam that is a genuine rest state → the two sides are separate JTBDs, this
     Flow fails the litmus, use this verdict. A seam that is not a rest state (the actor is
     mid-task, would consider the process incomplete if it stopped there) → still one JTBD, no
     matter the raw count — demote only if the whole thing is truly one Process. When applying
     the litmus at each seam still leaves real disagreement, that disagreement — not a guessed
     verdict — is what goes to the BA.
3. **Named as an outcome, not an action** — §5.2 Flow = "recognized end-to-end outcome, commonly
   Noun-to-Noun" (Order to Cash, Hire to Retire); Verb + Business Object is the *Process* naming
   convention. A verb-first Flow name is the strongest single smell that the object is really a
   Process. STELLARNet: 23/26 verb-first, 0/26 Noun-to-Noun.
4. **Recognized by the business, at the right LEVEL.** §7 points at the Microsoft Dynamics 365
   Business Process Catalog for the published set of end-to-end processes and its hierarchy.
   Citing the catalog alone is not enough to act on — the v2.12.0 pilot reported doing this check
   "by feel and wrote plausible justifications after the fact", which is fabrication invited by an
   under-specified instruction. So apply it as a test you can actually run, in order:

   | Level | Test that PASSES this level | Verdict |
   |---|---|---|
   | **End-to-end process** | Names an outcome the business itself would recognize and would say it "runs" (Order to Cash, Hire to Retire). Starts at an external initiating event, ends at a settled business result. Crosses several functions. | mint a `BF-` id |
   | **Process area** | A coherent grouping inside a journey ("Order Fulfilment") — has a lifecycle phase feel, but nobody says the business "runs Order Fulfilment" end to end. | this is a **Stage**, not a Flow |
   | **Business process** | Produces one defined business outcome, has one owner, sits inside a phase ("Pick and Pack Order"). Verb + Business Object names it naturally. | this is a **Process** |
   | **Scenario** | A variant or path through a process ("pick with substitution"). | a branch inside a Process, not a node |

   Two discriminators that settle most disputes without the catalog: (a) **would a stakeholder
   say the business "runs" this, end to end?** If it only makes sense as something a *user does
   in the system*, it is a Process; (b) **does the name want a verb?** Verb + Business Object is
   the Process convention (§5.2) — needing one is strong evidence of the Process level.
5. **Internal coherence — does ONE sentence cover everything inside it? (added v2.14.0.)** Tests
   1-4 all look at a Flow from OUTSIDE: its boundary, its name, its level. None asks whether its
   contents hang together, and a Flow can pass all four while quietly housing work that belongs to
   a different journey. This is not a corner case: on STELLARNet the four tests plus a 3-panel
   reconciliation, four adjudications and a full stage re-layout all passed, and an external
   benchmark then found **7 of 12 Flows** carrying foreign material — administration and
   reference-data upkeep filed inside the operational journey that CONSUMES it (booking intake
   config inside the booking journey, licence status inside the directory journey, dashboard
   personalization inside sign-on). Run it in three parts:

   - **State the one sentence.** Who starts this Flow, what they get, and why — and it must cover
     EVERYTHING in the Flow, not just its spine. If the sentence needs an "and also", the Flow has
     two journeys in it. Then check every Stage and Process against that sentence.
   - **Chain, not category (the discriminator).** When you pull the foreign material out, the
     temptation is to name what it has in common and call that a new Flow. Do not: shared
     *properties* make a category, and a Flow is a *chain*. Ask whether the pieces hand state to
     each other — is any Process's exit criterion another's entry criterion? On the pilot, seven
     removed Processes shared a clean, defensible-sounding membership rule ("a hospital-scoped
     value governing tenant behaviour, read by another journey at runtime") and formed no chain
     whatsoever: nothing handed anything to anything. They shared a scoping key, not a thread.
     A rule that admits members by property will keep admitting them as the corpus grows, which
     is the signature of a category — and the pilot's rule leaked exactly that way, matching a
     Process word-for-word in a Flow that had not even been looked at.
   - **Sweep the WHOLE corpus before minting anything.** A pattern found in the Flows you happened
     to examine is not yet a pattern. Both pilot panels proposed (or rejected) a journey from a
     7-of-12 slice; neither swept the other five, and the counter-example that broke the proposal
     lived there. A sliced dossier is a build failure to escalate, not a caveat to record.

   **A gap at the head does not disprove a journey.** Step 4 defines a GAP as work the business
   does OUTSIDE this system, so missing implementation is the definition of a gap and can never be
   evidence that the journey is unreal. Judge the journey on whether the surviving Processes form a
   chain; a gapped head merely removes the evidence that would have shown one, which puts the
   burden on the remaining links. When they cannot carry it, the honest output is an escalation
   with a named candidate journey — recorded ONCE, not scattered as orphans — and the `BF-` id is
   minted only after the BA confirms the business runs that journey at all.
   When a candidate still sits between two levels after both tests, record the ambiguity for the
   BA rather than resolving it silently; the level decision is where a wrong call propagates
   furthest.

**A Domain's Core-Object unity (Phase 3) is not evidence a Flow shouldn't split — the same
conflation error, running the opposite direction (added v2.13.0).** The whole point of Phase 5a
is that the Process axis is an independent decomposition from the Capability axis; this section
has so far only warned against the failure that collapses Flows DOWN to match Domain boundaries.
An adjudicated pilot disagreement found the mirror-image mistake: a panel argued two clusters
(personal calendar entries and their attached web meetings) must stay one Flow because their
shared Domain declares one Core Object ("Schedule Entry") spanning both. That reasoning proves
too much — it would equally argue a Domain's *third* variant (facility/equipment reservation, a
genuinely separate JTBD with its own object, correctly split out by the other panels) belongs in
the same Flow too. Phase 3's Domain-identity test answers "is this one well-formed Domain?"; it
does not answer "is this one Flow?" — apply the boundary litmus at the seam (glossary's own
rest-state test) to decide a Flow split, never the Domain's object declaration alone.

**When MOST candidates fail test 2, stop resolving them one at a time and look at the seam
(added v2.14.0).** The four-way resolution is built to adjudicate a single-domain Flow on its own
merits, and applied faithfully it will happily return "keep, single-domain, gaps recorded" ten
times in a row — each verdict locally correct, the set of them missing the point. Two independent
panels working the same 16-candidate inventory both stopped and reported the same thing: nine of
their keeps failed test 2 at the *identical* seam, because the product has no outbound step at
all. Surveys identify non-responders with no channel to chase them; notices record read-state but
never push; courses scope an audience and never tell it; schedules never invite or remind;
bookings never confirm. That is not nine single-domain journeys — it is **one missing capability,
observed nine times**, and it is precisely the step that would have crossed a domain in every one
of them. So: after running the acceptance test across the whole candidate set, tabulate *where*
the test-2 failures fall. If the same missing step recurs across unrelated journeys, record it
once as a product-level capability gap and say so plainly in the 5a output — a reader given ten
separate "gaps recorded" notes will not reconstruct it, and it is usually the most decision-useful
sentence the whole phase produces. The same sweep is worth running for a missing *actor*
lifecycle: the same pilot found nothing anywhere in 252 Processes that creates, moves or
deactivates a staff record, which no single Flow's verdict would ever have surfaced.

**Recorded, not yet fixed (v2.12.3 third pilot, single-panel signal only — weaker than the
findings above, tracked so they aren't lost, not acted on from one report each):**
- Verdicts 2 and 4 are not actually mutually exclusive — a Flow can carry both a real gap AND a
  boundary-litmus conflict, and the if/elif shape only returns one, silently dropping the other
  signal (seen once, on a 30-Process Flow: one agent's own splitting choices may have created
  the case rather than the table).
- A verdict-2 gap can point at a domain that does not exist yet in the taxonomy (seen once: a
  missing competency-record gap in Learning, a missing billing-record gap in Facility
  Reservation) — the "would cross a domain if filled" wording assumes the target domain is
  already there.
- Upstream Flow-count calibration (how many Flows a system's worth of Processes should become)
  has no stated rule; three panels across two pilots produced spreads of 8-16 and 13-17
  respectively with no way to tell an over-split from an under-split.

**The judged benchmark cannot substitute for these tests** — it measures internal coherence, so a
one-Process "flow" trivially scores F1 5 / F2 5 while a genuine multi-stage journey scores 1-2.
On STELLARNet every mis-levelled flow passed and every real one failed. Scope must be checked
here, at construction, not inferred from rubric scores.

**Actor registry (added v2.7.0, from the OdooDNA DD pilot)** — `actors` is NOT free text. Every
actor name on a Process comes from a per-project closed registry
(`project-dna/_actor_registry.json` — project-local data like the domain dictionary, never synced
into this skill): a small list of `{name, kind: HUMAN|SYSTEM|EXTERNAL, description, aliases[]}`.
An enrichment batch either REUSES a registry name verbatim or explicitly PROPOSES an addition in
its structured output (`proposed_actors`), and every proposal must first pass a near-duplicate
check against all existing names+aliases: case-insensitive match, substring containment, and
synonym ("Salesperson" vs "Sales Rep", "Portal Customer" vs "Customer (portal)" — both pairs
shipped as coexisting duplicates in the pilot because no registry existed). Gate: no two registry
entries may be near-duplicates of each other, and every `actors` value on every Process must
resolve to a registry name (quality-gates.md → Actor-registry hygiene). The registry is also what
diagramming.md's actor→lane classification consumes — the reference project's 160 distinct
free-text actor strings for ~4 real lanes is this exact failure mode, previously only patched
downstream at render time.

**`jtbd`** (added v2.0.0) — every Process carries `{"when": str, "want": str, "so_that": str}`,
Jobs-to-be-Done structure naming the ONE job this Process completes. The existing free-text
`purpose` field stays unchanged, additive — `jtbd` is the structured, checkable version of the same
idea. A Process with 2+ genuinely independent JTBDs packed into one node needs to split.

**Process boundary litmus (sizing by JOB, not by step count)** — the question that decides where
one Process ends and the next begins: "Has the actor received the FULL value they needed, even if
nothing else runs next?"
- **YES** → this is a legitimate Process-ending outcome (a "rest state") — the boundary is real.
- **NO** → this is a Task or phase inside the CURRENT Process, not a Process of its own.
Never size a Process by counting steps — a Process with many steps but one JTBD is still one
Process; conversely a 2-step node that already delivers full actor value is a complete Process, not
an under-sized fragment.

**`process_kind`** — `PROCESS` (does the work) vs `CONTROL` (gates other work: approval, validation
checkpoints; carries `controls_process_id` pointing at what it gates). (Tradom: 251/58)

**Decision/checkpoint modeling (added v2.0.0)** — a CONTROL node with only ONE possible outcome is
not a business decision (it's a validation/Task step wearing a checkpoint's clothes) — demote it to
a Task inside its owning Process. A REAL checkpoint carries:
- `decision_maker` — who/what decides (a role, or "System" for an automated rule).
- `decision_branches` — `[{"condition": str, "outcome_label": str, "target_process_id": str}
  | {"condition": str, "outcome_label": str, "terminal_outcome": str}]`, **2 or more entries**,
  one per business-meaningful outcome. Each entry is EXACTLY ONE of two shapes (added v2.4.0 —
  formalizes what was previously "a terminal outcome label" stuffed into `target_process_id`,
  which real data showed agents doing 61% of the time with no field to put it in properly):
  `target_process_id` when the branch hands off to another real Process (must resolve to a real
  id); `terminal_outcome` when the interaction just ends here (a short description of the
  end-state, e.g. "Access denied — action blocked"). Never write prose into `target_process_id`.
Replaces the old single-target `controls_process_id`-only shape for anything that's a genuine
decision; `controls_process_id` stays as-is for simple validation gates with exactly one path
(retry-until-pass style), which are not decisions. See diagramming.md for how `decision_branches`
renders (diamond node, one labeled dashed edge per branch — to the target Process, or to a small
terminal-outcome marker node for `terminal_outcome` branches).

**BPM-guideline cross-references (added v2.8.0)** — Flow/Stage/Process nodes may carry optional
`bpm_id` (+ `bpm_mnemonic` on a Flow) fields cross-referencing the QMS BPM guideline's own id
scheme (`BF-O2C` / `BS-O2C-03` / `BP-O2C-003`), and an optional `bpm_review` map tracking each BPM
information object's human-review state (`MISSING` / `AI_SUGGESTED` / `DOC_CONFIRMED` /
`VERIFIED` — closed vocab). All semantics, the derivability contract (which objects code can
draft vs. which only a BA can supply), and the VERIFIED-is-a-human-signature invariants live in
`references/bpm-alignment.md` — read it before producing any BPM-guideline-conformant output.
Distinct from the Feature `status: PLANNED` lifecycle and from the finding `category` — never
merge the vocabularies.

**Flow/diagram size** — a Flow with an unusually high Process count (review threshold: ~20–25,
see quality-gates.md) is a rendering-complexity signal, not automatically a scope problem — see
diagramming.md's Flow/diagram splitting rule. Whether the FLOW's business scope itself is too broad
(multiple JTBDs bundled into one Flow) is a separate, human-judged question surfaced alongside the
rendering signal, never auto-decided from process count alone.

**Typed relationships** (both axes use the same closed set, field `relationship`):
`USES_DATA_FROM` · `TRIGGERS` · `CONTROLLED_BY` · `INTEGRATES_WITH` · `NOTIFIES_THROUGH` ·
`AUDITED_BY` · `PRESENTED_BY` · `AUTHORIZED_BY`. Always typed — a flat "related to" list is
banned because it can't drive any downstream view.

**Rule buckets** on a Process — business logic attached where it executes, split by kind:
`business_rules`, `validation_rules`, `state_rules`, `defaulting_rules`, `integration_rules`,
`ui_behaviors`, `status_transition`, `exception_flow`.

**Bucket litmus tests (added v2.7.0, from the OdooDNA DD pilot** — until then the 8 buckets were
names only, and a field pilot showed agents filing by surface resemblance; counter-examples below
are real, generic-ized pilot misfiles):

| Bucket | Belongs here IFF | NOT here (real counter-example) |
|---|---|---|
| `business_rules` | A policy or calculation shaping the outcome of normal work | — (the default home for genuine policy, incl. audit-trail behavior — see exception_flow row) |
| `validation_rules` | The system REFUSES an input/action failing a condition — the actor sees a block | A rule that silently adjusts data instead of refusing → defaulting/business |
| `state_rules` | Something is allowed/forbidden BECAUSE of the record's current lifecycle state | A transition itself → status_transition |
| `defaulting_rules` | The system fills a value the actor didn't supply | — |
| `integration_rules` | Governs an exchange with a system OUTSIDE this deployment (payment provider threshold, signed-PDF handoff to the customer, quotation emails) | "Invoice lines keep a bidirectional link to their reversal counterpart" — internal data linkage between the system's own records → business_rules. External-facing test cuts both ways: pilot had genuine external rules mis-filed in other buckets too |
| `ui_behaviors` | The screen shows/hides/enables something; no data rule involved | — |
| `status_transition` | The allowed state graph itself (from → to + trigger) | — |
| `exception_flow` | Answers "what happens when something goes WRONG mid-process" (failure, rejection, cancellation, rollback, recovery) | A priced feature ("costs re-invoiced at markup") → business_rules; normal automation ("reward fully covers the order → auto-creates the zero-total invoice") → business_rules; audit logging ("a message records old and new quantity") → business_rules/ui_behaviors — none of these is anything going wrong |

**Attachment litmus** (same addition): a rule attaches to the Process whose JOB it constrains —
if the sentence is about a different screen/journey than this Process's `jtbd`, it's misattached
even if topically nearby (pilot: portal-home LISTING behavior filed under the accept/decline
process). Flag-don't-force-fit applies to rules exactly as to findings.

**Rule-sentence bar (added v2.7.0)** — every bucket entry is ONE sentence that:
1. **Names its subject** — the system or a registry actor: "The system confirms the order once
   the authorized amount reaches the total", never subject-less "Confirms orders once…".
2. **Carries no raw field/enum/class identifiers in prose** — those belong in the evidence ref.
   A state name may appear only WITH its business gloss: "once the order is confirmed (state
   'sale')", never bare "…must carry null/zero product data…".
3. **Uses no implementation vocabulary** — debounce, null, invocable, DTO, ORM, payload,
   callback, cron, and kin. Same concrete-marker bar as quality-gates.md's conservative-renaming
   rule: flag on a concrete marker, never on "sounds technical".

**Scrubbing an existing corpus against this bar — what NOT to strip (measured, v2.17.2).** The
repair round this bar anticipated is content surgery on real extracted business facts, so the
failure mode that matters is not "missed a marker", it is **deleting information while tidying
vocabulary**. Two FP classes were measured on a live 2,604-sentence corpus and must survive a
scrub untouched:
- **Universal business/ERP abbreviations** — `BoM`, `UoM`, `PoS`, `IoT`, `B2B`/`B2C`, `VAT`,
  `IBAN`, `SEPA`. CamelCase-shaped but ordinary domain language; `check_bpm.py`'s `CAMEL_ALLOW`
  now carries these so the linter stops flagging them (~80% of that marker's hits on the
  reference corpus were this class, not code).
- **Real names of real systems the business transacts with** — a government e-invoicing portal
  (`TicketBAI`, `MyInvois`, `FatturaPA`, `JoFotara`, `VeriFactu`), a named standard (`UBL 2.1`,
  `EN16931`, `Peppol`), a vendor (`YouTube`, `PayU`). These are the business fact. Replacing
  "submits to TicketBAI" with "submits to the tax portal" destroys the one detail a reader
  needs. Keep the name; scrub the plumbing around it.
Three more FP classes were measured *after* a full 384-sentence repair round completed (v2.17.3),
by reading what the lint still flagged once the genuine defects were gone — the linter now guards
all three, but a scrubbing agent should recognise them by eye too:
- **A job title is not a software component** — a `credit controller` is a person. Same for
  financial / stock / inventory / quality controller.
- **A physical device is not an auth string** — a `hardware token`, `USB token` or `fiscal token`
  is an object someone holds, and in compliance processes it is precisely the business fact.
- **A business digit-run is not a raw sentinel** — `1/2/3-step manufacturing`, a `4/6/8-digit
  HSN/SAC code`. These are quantities a business person states out loud.
The rewrite rule that follows from all of them: **change the vocabulary, never the fact.** Where the
technical term IS the business fact (a named standard, a regulator's system, a real integration
partner), keep it. Where a lifecycle state appears, add the gloss rather than deleting the state.
A sentence that comes back shorter but vaguer has failed the round, not passed it.
Pilot measurement before this bar existed: 39% BUSINESS / 39% MIXED / 22% CODE_HEAVY. This is a
dispatch-prompt requirement plus an audit-weighted item (agent-orchestration.md), deliberately
NOT yet a hard `check_gates.py` gate — existing corpora would fail wholesale until their
data-repair rounds land.

## System axis — Service / Component / Surface / Topology (added v2.5.0; named v2.16.0)

The third axis, beside Capability (`DOM-*`) and Process (`BF-*`): **what the system is made of**.
Called the "Infra axis" from v2.5.0 to v2.15.0 — renamed because it holds application modules,
datastores and external services, not deployment plumbing. Nodes run `service → component →
surface`, mirroring C4's Container → Component → Code. Recorded in `project-dna/_infra_map.json`
and loaded adapter-independently — see dna-store.md's "System axis" section for shapes and the
`finding.service_id` / `finding.component_id` derivation rules. All enums below are closed sets,
defined in BOTH `build_dna_store.py` and `check_gates.py` (kept in sync) and enforced by both.

**Service `kind`** (`SVC-{MNEMONIC}`) — follows the 12-factor backing-service framing (a service
is a deployable or attached resource the app treats as a named dependency):
- `FRONTEND` — a UI application users load and operate.
- `BACKEND` — an application service executing business logic.
- `DATABASE` — a system-of-record datastore.
- `SEARCH` — a search/index engine serving queries the datastore can't.
- `QUEUE` — a message broker / async job queue decoupling producers from consumers.
- `CACHE` — a volatile lookaside store holding recomputable data for speed.
- `GATEWAY` — an edge router/proxy/API gateway fronting other services.
- `EXTERNAL` — a third-party system outside the project's own deployment boundary.

**Component `kind`** (`CMP-{MODULE-ROOT}`, added v2.16.0) — the module tier between a service and
its findings: the unit humans name, reuse, review and release. Fully derived from
`finding.module`; never hand-written.
- `ADDON` — a module under an `addons/` directory (the platform's own plug-in unit).
- `FRAMEWORK` — a non-addons framework subtree the platform ships (e.g. `odoo/orm`).
- `PROJECT` — a component the project owns that is neither of the above.

**Component `origin`** — the field that answers "did *we* build this, or did the platform ship
it", which is what makes reuse and release-note questions answerable:
- `CUSTOM` — project-authored; declared in `_infra_map.json`'s `components.custom` list.
- `VENDOR` — shipped by the upstream platform. The default: origin is authored, not inferable.

**Surface `kind`** (`SRF-{MNEMONIC}`) — one externally-visible face of a service:
- `SCREEN` — a UI screen a human operates.
- `API` — a callable interface other software consumes.
- `BATCH` — a scheduled/background job surface.
- `ENTITY` — a persisted business record type the service owns.

**Topology edge `type`** (rides in `edges.jsonl` as `kind: TOPOLOGY`, service endpoints only):
`CALLS` (synchronous request) · `READS` / `WRITES` (data access direction) · `PUBLISHES` /
`SUBSCRIBES` (async messaging direction). Two provenances (v2.18.0): **authored** in
`_infra_map.json` `edges[]` by an agent who quoted the call, or **hop-lift** (`derivation:
"hop-lift"`, always `CALLS`, `support` = call sites) — the builder folding function-level
`EXTERNAL_HOP` evidence up to the service pair. Module-level edge derivation stays banned: a
finding merely *living in* a module is never an edge; a cited call site is.

## Layer 6 — Update rounds

**Update round** — one recorded unit of DNA maintenance. `kind`: `INITIAL_BUILD` (the baseline) /
`INCREMENTAL_RESCAN` (diff-based catch-up after a source pull) / `RESTRUCTURE` (added v2.1.0: an
approved structural apply — taxonomy splits/moves/dissolves, id remaps, field backfills — with NO
rescan; the corpus is untouched, source pins carry forward unchanged with a note). Identified by
`UPD-YYYY-MM-DD-NN`. Every round entry must carry the full stats shape regardless of kind —
`corpus_totals` (restated even when unchanged), `capability_axis`, `process_axis`,
`views_published` — because per-round views render each entry uniformly (see update-playbook.md's
round-entry template note; learned when the first RESTRUCTURE entry, written lean, silently blanked
a project's update-history page).

**Threading verdict** — when threading new findings into the existing capability axis, every
finding-cluster gets exactly one of:
- `UPDATE` — an existing Feature's text is stale/incomplete; revise description/size, append rd_ids.
  (Corrections matter as much as additions — e.g. a "3-month window" that became 12 months.)
- `NEW` — genuinely uncovered ability; create a Feature with the next sequential id.
- `IGNORE` — pure bug fix / implementation-internal / already fully covered. Recorded with the
  reason; its rd_ids stay in the corpus but join no Feature.

The **forward direction** (requirement intake, the `tps-quantification-intake` skill) uses the same
UPDATE / NEW pair, but its third verdict is `ALREADY_COVERED` instead of IGNORE — the system
already does what's being asked; the verdict cites the covering Feature with its evidence links
and changes nothing. IGNORE dismisses evidence; ALREADY_COVERED answers a request.

**`COVERED` vs `ALREADY_COVERED` (clarified v2.5.0)** — the SAME concept in two contexts, defined
together here: `ALREADY_COVERED` is the intake VERDICT `action` ("the system already does what's
being asked" — the headline answer to a request); `COVERED` is the intake CROSS-REFERENCE ROW
`status` the same skill puts on each touched node ("this node already handles it; listed for
traceability, nothing on it changes"). Both spellings stay — they are load-bearing in existing
ledgers — and a full merge into one spelling is deferred. Do not confuse either with the finding
`category` value `COVERED` (Layer 1, above), which is about DOCUMENTATION coverage of observed
code behavior — a different concept entirely.

**History round families & the debt ledger (added v2.5.0)** — the update round is no longer the
only round family; History is three families plus a debt ledger (store collections + shapes in
dna-store.md's "History & ledgers"):

- **Intake round** (`INTAKE-YYYY-MM-DD-NN`) — one CONFIRMED forward-direction quantification
  round, from `_intake_ledger.json`. Its `verdicts` array is core store data — the
  machine-consumable heart the PLANNED-trace gate reads.
- **Release round** (`REL-YYYY-MM-DD-NN`) — one release event: which features shipped, which
  services deployed, from `_release_ledger.json`.
- **Debt** (`DEBT-YYYY-MM-DD-NN`) — something a round OWES the DNA, from `_debt_ledger.json`.
  `kind` (closed):
  - `HOTFIX` — code shipped past the gates (emergency fix); owes the evidence/scan that normal
    discipline would have produced.
  - `MAP_OUTDATED` — a reviewer/tester proved production diverged from what the map says; owes
    the correcting update.
  - `UNRULED_AREA` — bug route ③: a fix landed in territory the map doesn't cover; owes coverage
    of that area.
  `status` (closed): `OPEN` (still owed) / `SETTLED` (paid — must cite the settling `UPD-` round
  id in `settled_by`, gate-checked). Every update round walks the OPEN debts before it closes
  (update-playbook.md § 4c).

## Cross-cutting

**Provenance fields** — `legacy_*` (ids/names from two-or-more eras ago), `previous_*` (the
immediately prior era), `merged_from` / `split_from` (structural history). See id-schemes.md.

**Object relationships (domain level)** — how one domain's core business object relates to
another's (adopted from the capability-catalog framework): `EXTENDS` (inherits base attributes,
adds its own lifecycle after a declared divergence point — signals "extend, don't duplicate"),
`COMPOSES` (parent object owns the child's lifecycle), `REFERENCES` (points by id only, no
inheritance), `Standalone`. **Distinct from typed capability_relationships** (USES_DATA_FROM,
TRIGGERS...): that set describes BEHAVIOR between capabilities/processes; this set describes
DATA/lifecycle relationships between domains' core objects. Never mix the two vocabularies.

**Ticket/evidence links** — findings and rules link to real issue-tracker tickets and commits,
derived from the source repos' own `git log`/`git remote -v` — never guessed URLs.

**Domain dictionary** — a project-local reference file (`project-dna/domain-dictionary-*.md` —
lives alongside that project's own DNA data/config, e.g. next to `dna-store.config.json`, NOT
inside this skill folder) that pins the target system's BUSINESS vocabulary: every entry anchors
a standard term to the real source (model/field, file:line — grep-verified, never from memory),
lists the aliases heard on the project that must collapse into it ("item"/"SKU"/"skus" → one
standard term), names the concepts it's commonly confused with, and marks genuinely ambiguous
terms with ⚠ (agents must ask, not guess). Two-way lookup tables (by standard term AND by alias)
make it searchable from whatever word someone just said. Strictly separate from THIS glossary
(which covers the pipeline's own methodology vocabulary) and strictly project-local — it is
evidence from one codebase, so it never syncs to another project and never ships in the shared
skill/plugin. **Priority, not mandatory**: worth having once a project has enough vocabulary
surface to need one, but plenty of projects — especially early on, or small ones — will never
build one; the DNA itself doesn't depend on it and grows fine without it, term-by-term, as
bootstrap/update rounds surface real vocabulary. Validated first on OdooDNA
(`domain-dictionary-erp.md`, Odoo-anchored ERP/e-commerce vocabulary + companion changelog).
