# Project DNA — agent orchestration patterns

> **In kiln:** this page is tps-project-dna v2.18.1's text, verbatim. The scripts and files it names
> are that project's; [reading-note.md](reading-note.md) says what each one is in kiln, and where
> the two disagree, kiln's commands win.

How to spend agents well on this kind of work. Scale reference: the Tradom DNA used ~300+ scanning
agents across 11 rounds, plus dozens of clustering/classification batches — these patterns are what
kept them consistent.

## Dispatch patterns

- **Batch by real work size, not file size.** For diff re-scans, batch by `git diff` line count
  per file (a 9,000-line file with a 40-line diff is a tiny job). For first-time scans, chunk big
  files by exact line ranges computed beforehand; group many small files per agent.
- **Parallel + domain-scoped.** Fan out one agent per domain/topic/flow batch. Blind batches
  (agents don't see each other's output) then an explicit merge/consolidation step beats trying to
  share state.
- **Give agents the REAL ground truth, in full.** A clustering agent deciding UPDATE-vs-NEW must
  read the target capability's complete existing Feature text, not a summary; a scanning agent
  gets the actual diff/chunk, not a description of it. Summaries into prompts = wrong verdicts out.
- **Structured output, always.** Findings/proposals come back as JSON with the closed-enum fields
  from glossary.md. The merge script consumes those fields directly (see quality-gates.md:
  trust-structured-output).
- **Model tiers**: cheap+fast (Haiku-class) for volume scanning and mechanical classification;
  stronger models for exact-partition decomposition, judgment-heavy consolidation, and anything
  where one wrong verdict propagates (the reference project deliberately used Sonnet-class for its
  22 split-decomposition calls). When a stronger tier costs little at your call count, take it.

## Instructions that must be IN every dispatch prompt

1. The closed enum values it may use (paste from glossary.md — don't make agents guess).
2. **Flag-don't-force-fit, and keep the two failure modes separate**: `misassigned` = the finding
   belongs under a DIFFERENT EXISTING capability/domain (name which one, with reasoning) — that
   scope just wasn't in this agent's batch. `taxonomy_gap` = the finding doesn't genuinely fit ANY
   existing capability or domain — flag it separately with a proposed name/description and its
   rd_ids, do NOT default it into the nearest existing bucket just because `misassigned` requires
   naming a real target. Agents correctly pushing back on your batching or your taxonomy has
   repeatedly caught real dispatch mistakes AND real structural gaps.
3. Business-language requirement: propositions are one-sentence statements of behavior; names
   are business-first noun phrases (no table/component/implementation nouns).
4. The deliverable-language rule (e.g. English-only content).
5. Evidence duty: cite the code location / ticket id for every claim.
6. **Implementation-variant check, for scanning batches over DI/interface-heavy codebases**
   (added v2.4.0): before writing a finding from a Repository/Service/Store/Client class, check
   whether it's ONE OF SEVERAL concrete implementations of the same interface (sibling folders or
   projects named In-Memory/Mock/Fake/Stub/Test alongside a real one, or a `grep -r "class.*:.*I<Name>"`
   turning up more than one hit). If so, the finding's `proposition` must say which variant this
   is and must NOT be phrased in generic business prose that erases the distinction — e.g. not
   *"User authentication requires matching hospital, user ID, and password"* (reads like the real
   login) but *"In the in-memory test-double UserRepository, matching..."* (confirmed real
   incident: STELLARNetDNA's RD-0356 came from `STELLARNet.InMemoryDataStore/.../UserRepository.cs`,
   worded generically enough that Phase 4 clustered it into the real login Feature, whose actual
   implementation is a completely different external Authenticator service — the codebase's own
   `InMemoryModuleDependencySetup.cs` vs `ProductionModuleDependencySetup.cs` split proves the two
   were never meant to be conflated). See bootstrap-playbook.md Phase 4's matching verification
   step — this dispatch instruction is what makes that step checkable.
7. **For any Phase-4b `business_description` dispatch** (added v2.0.0): paste glossary.md's
   `what_it_does`/`input`/`process`/`output` template, the banned-jargon list (dotted technical
   identifiers, controller/endpoint/session/token/ORM/table/query), and the one worked before/after
   example verbatim — don't paraphrase it, agents calibrate against the exact wording.
8. **For any Process-enrichment dispatch (actors + rule buckets, added v2.7.0)**: paste
   glossary.md's bucket litmus table, attachment litmus, and rule-sentence bar verbatim, plus the
   project's CURRENT actor registry (`project-dna/_actor_registry.json`). The batch reuses registry
   names verbatim or returns explicit `proposed_actors` entries — a new free-text actor name
   written inline into a Process record is a defect, not a shortcut.
9. **Claim-strength discipline (added v2.7.0)**: "only", "never", "always", "cannot", "must" are
   STRONG claims — a sentence may claim exactly what its evidence supports, no more. For every
   strong claim the agent must QUOTE the guard's actual predicate in the finding/rule evidence,
   and the sentence's strength must match that predicate: a guard raising only when the order is
   in state `'sale'` supports "the pricelist cannot be changed once the order is confirmed", NOT
   "can only be changed while still a draft" (real pilot error — sent quotations were still
   editable; second pilot case: write() permitted subsection→section, so "display type can never
   change" was factually false). Compressing a guard into a stronger paraphrase is an inherent
   LLM failure mode — the control is the quoted predicate plus the strong-claim spot-check
   (reconciliation section below), never trust in the prose alone.

## After the fan-out (the orchestrator's own checklist)

- **Completeness cross-check by script**: union of all agents' covered ids == the full input id
  list, exactly once each. Run BEFORE merging. Orphans get a dedicated follow-up dispatch (never
  hand-wave them into the nearest bucket yourself).
- **Follow up flags**: every `misassigned` item gets re-dispatched to the right scope.
- **Taxonomy-gap synthesis**: collect every batch's `taxonomy_gap` flags into one list, cluster
  duplicates/near-duplicates, and write a short taxonomy-extension proposal (candidate new
  capability under an existing domain, or rarely a new domain) with supporting rd_id counts and
  evidence. Get the user's explicit approval — never add a domain/capability node unilaterally —
  then apply it via a mechanical script per id-schemes.md, and re-dispatch the freed findings for
  real clustering under the new node.
- **Consolidation pass**: parallel batches fragment categories/features; schedule an explicit
  merge-fragments step after any large clustering fan-out.
- **Sample-audit**: read a few raw agent outputs end-to-end each round; a systematic
  misclassification found early (one round's `classify()` audit on the reference project) is cheap,
  found late it poisons everything downstream.

## Multi-pass classification & reconciliation (added v2.0.0)

**LLM classification output is a draft for human review, never an auto-accepted final answer**
(SKILL.md Core Principle 9). Confirmed by real measurement: the same semantic-classification test
run 3x independently agreed only 60-70% of the time. Multiple valid decompositions can genuinely
exist for the same source (like a book chaptered different-but-valid ways) — that doesn't excuse
skipping gate-checks, it means judgment-heavy verdicts need a reconciliation step baked in, not
treated as one-shot-correct.

- **Applies to**: judgment-heavy batches — leveling/splitting verdicts (Identity-litmus calls),
  `business_description` writing, actor-lane classification, and anything else where a "reasonable
  person could see it differently" is a real possibility. **Does NOT apply to**: mechanical
  extraction (finding scanning, id assignment, structural gate-checks) — those have one correct
  answer and multi-passing them just wastes agents.
- **Practice**: run the same batch 2-3x with independent fresh-context agents (no shared
  conversation history — a second pass that sees the first pass's answer just rubber-stamps it,
  same principle as `tps-quantification-intake`'s Tech Lead review). Diff the results field-by-field.
  - Agreement at or above a working threshold (e.g. 2-of-3 concordant) → spot-check the majority
    answer, proceed.
  - Agreement below threshold → the disagreement itself is the finding: don't just re-roll a 4th
    time hoping for consensus — read what each pass actually said and fix the ambiguous
    litmus/dispatch-prompt wording that let them diverge, THEN re-run.
- **Record the agreement rate** in the round's progress-log entry — a round that silently picked
  "pass 1's answer" with 60% agreement across the batch is a materially different confidence level
  than one with 95% agreement, and future readers need to know which they're looking at.
- This generalizes quality-gates.md's existing "PARTIAL_MISMATCH is the highest-risk category —
  audit it first, and hardest" pattern: concentrate reconciliation effort where ambiguity is
  actually highest (measured, not guessed), not spread evenly across a whole batch.
- **Strong-claim spot-check (added v2.7.0)**: every round that wrote/updated rule or proposition
  sentences, grep them for strong-claim markers (only, never, always, cannot, must, exclusively),
  sample `min(20, all hits)`, and verify each sentence's strength against its quoted guard
  predicate (dispatch instruction 9 above). Mismatch rate above ~10% → sweep EVERY strong-claim
  sentence from the same batch before the round closes, same escalation rule as the random-sample
  audit. This is the Principle-9 control for paraphrase-compression: the error class (a guard
  restated as a stronger claim) reads fluent and correct, so only predicate-vs-sentence comparison
  catches it — never prose review alone.

## Autopilot tiers — agents pre-fill every judgment step; humans review at round gates (added v2.7.0)

User-set direction: the pipeline must run hands-off ("auto pilot") WITHOUT abandoning
propose-then-apply. The resolution is tiering, not exemption — every judgment-bearing
collection step (service-resolution fills, actor-registry additions/merges, bucket refiles,
new EXTERNAL service records) is AGENT-PRE-FILLED as part of the round itself; the human
never hand-fills a table. What changes per tier is only how the pre-fill gets applied:

- **Tier A — mechanical, auto-applies**: closed-rule extraction/derivation (extractors,
  function-match hop derivation, id assignment). Gates, no human step. (Unchanged.)
- **Tier B — agent-filled, auto-applies when an OBJECTIVE check passes**: cases with no room
  for judgment — a resolution hint whose host string exactly matches an existing service's
  name/root; an actor alias differing only by case/spacing/punctuation. Auto-apply with
  provenance (`filled_by: agent`, the objective check named) + gates. An objective check is
  one a script could evaluate — if the justification needs a sentence, it is Tier C.
- **Tier C — agent-filled, human bulk-reviews at the ROUND gate**: real judgment (synonym
  merges like "Sales Rep"="Salesperson", naming a new EXTERNAL service, bucket refiles,
  claim-strength rewrites). The agent proposes 100% of rows — `proposed` + `rationale` per
  row, UNRESOLVED where genuinely undecidable — and the round's confirmation gate presents
  them as ONE reviewable diff (the intake Draft→Confirmed model). Human accepts/edits in
  bulk; nothing applies before that gate; the reconciliation rules above (multi-pass,
  agreement rate, strong-claim spot-check) still govern how the pre-fill is produced.

Placement: bootstrap runs collect + pre-fill in the SAME round (Phase 2b/5); update rounds
pre-fill deltas only. A round's progress-log entry records per tier: auto-applied count
(B), reviewed count + edit rate (C) — a high C-edit rate means the pre-fill prompts or the
litmus need fixing, which is skill feedback, not a reason to hand-fill next time.

## Resilience under rate limits / session caps

Large fan-outs (dozens of parallel agents) will eventually hit a transient API rate-limit, a
temporary safety-classifier outage, or the session's own token/usage limit — this is normal at
scale, not a sign something is broken. Learned the hard way on the OdooDNA Phase 4 clustering
fan-out (2026-07-27): dispatching ~30 clustering agents at once meant a single rate-limit/session-cap
event killed ~25 of them mid-flight in one shot.

- **Dispatch in small waves, not one giant fan-out.** Start conservative (3-6 concurrent agents per
  wave) for expensive/long-running batches; only widen the wave once you've seen a few waves land
  cleanly. Wait for a wave to finish (or fail) before dispatching the next — this bounds the blast
  radius of any single rate-limit/session-limit event to that wave, not the whole remaining backlog.
- **A `failed` task-notification does NOT mean the work didn't happen.** Agents killed mid-task by
  a transient error frequently already wrote a valid, complete output file before dying (the kill
  just cuts off their closing text response). Conversely a `completed` status is not proof the
  output is correct. Never trust notification status alone — always **audit by content**.
- **Build one reusable local audit script per fan-out** that, for every expected output file: checks
  it exists, parses as JSON, and — for partition-style outputs — recomputes the union of all
  returned ids and diffs it against the expected input id set (exact match, no dupes, no gaps). This
  is the same completeness-cross-check principle as "after the fan-out" above, just run continuously
  as a cheap, free, local re-runnable gate instead of once at the very end. Classify each expected
  output as DONE / INVALID / MISSING and only re-dispatch what's actually MISSING or INVALID — this
  alone can turn "batch reported failed" into "already done, skip it" for a large fraction of
  apparent failures.
- **Retry transient errors immediately in place**, same prompt, no data changes — rate-limit and
  classifier-unavailable errors are about API capacity at that instant, not about the task.
- Batch size is a live dial, not a one-time decision — adjust it up or down through the run based on
  observed failure rate and the user's stated risk tolerance (e.g. "I want
  accuracy" argues for smaller waves + audit-before-trust over raw throughput).

## Pacing & the user

- Long fan-outs run in background; if the user checks in ("is this stuck?"), answer transparently
  with what is running and why it takes this long — then let them choose thorough vs. fast via an
  explicit question if the cost profile changed.
- Structural decisions never ride inside an agent fan-out: pause, write the proposal, get the
  user's yes, then dispatch the mechanical wave.
