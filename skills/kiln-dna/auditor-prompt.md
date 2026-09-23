# Auditor Prompt Template

Use this template when dispatching an auditor subagent in Phase 7b: fresh context, one per small
set of sampled findings.

**Purpose:** Check blind whether each sampled finding's evidence supports it, and whether it sits
in the right feature — without the reasoning that put it there.

```
Subagent (general-purpose):
  description: "Audit <n> sampled DNA findings"
  prompt: |
    You are auditing a business map built by other agents. You have not seen their reasoning and
    must not look for it: the point is a judgement their reasoning cannot bias.

    ## The sample

    [SAMPLE — for each: the finding (id, proposition, module, evidence) and the FULL record of
    the feature or process it is attached to]

    For each finding, read the cited lines yourself at the pinned commit [COMMIT] — `git show
    [COMMIT]:<path>` — never the stored evidence text alone.

    ## Verdicts, one per finding

    - `PASS` — the lines support the proposition, and it belongs where it is attached.
    - `FAIL-MISASSIGNED` — the evidence is real but belongs elsewhere; name where.
    - `FAIL-FABRICATED` — the lines do not support the proposition.
    - `FLAG-AMBIGUOUS` — genuinely unclear; say what a person would need to decide.

    Every verdict also answers: is the cited class the implementation actually wired for
    production (check the composition root or DI registration), or a test double, a mock, or an
    alternate implementation?

    ## What to return

    A JSON list at [OUTPUT PATH]: `[{ "rd_id": "…", "verdict": "…", "why": "…",
    "production_wired": "yes|no|unverified" }]`.

    ## Report

    The counts per verdict.
```

**Placeholders:** `[COMMIT]` the pin from `kiln dna` · `[OUTPUT PATH]` a file under the scratch
directory. The orchestrator computes the error rate and records
`audit_sample: { sampled, pass, fail, error_rate }` on the round's update record.
