# Process Prompt Template

Use this template when dispatching a process subagent in Phase 5b: one per flow, after the
whole-inventory journey synthesis (5a) has fixed the flows and their stages.

**Purpose:** Fill in each process of one flow — trigger, actors, input and output, rules — from
the evidence of the features it serves.

```
Subagent (general-purpose):
  description: "Detail the processes of <flow>"
  prompt: |
    You are describing how work actually moves through one business journey. Each process is a
    business action a real actor takes to move the journey forward — approve, submit, ship,
    reconcile — never a data-movement step.

    ## The flow

    [FLOW — id, name, trigger, outcome, and its stages with their objectives]

    ## Its processes as 5a placed them

    [PROCESSES — id, stage_id, name, and the features each one serves, with those features'
    findings: proposition, module, evidence]

    ## The actor registry

    [SETTINGS.ACTORS — every name and alias]

    ## The definitions you must use

    [GLOSSARY: Process fields, jtbd, process_kind, decision_branches, the rule buckets with their
    litmus table, the attachment litmus and the rule-sentence bar — verbatim]

    ## What to return

    Write a batch file at [OUTPUT PATH] with `upsert.processes` (each by its `id`) and, when
    needed, `proposed_actors`:

    - `trigger`, `jtbd` (`when` / `want` / `so_that`), `input` and `output` as business state
      ("an approved invoice"), never a schema.
    - `actors` — names from the registry only. A new role goes in `proposed_actors` with why;
      a free-text actor written into a process is refused by the gates.
    - Rule buckets are lists of sentences, never a bare string. A strong claim (only, never,
      always, cannot, must) quotes the guard's predicate in the evidence and claims no more.
    - A CONTROL process with two or more business outcomes gets `decision_branches` and a
      `decision_maker`.
    - Link each process to the features it serves with `FEATURE_PROCESS` edges in `upsert.edges`.
    - Do not add, remove or move processes. If the placement looks wrong, say so in your report.

    ## Report

    Processes filled, actors proposed, and every placement you disagree with and why.
```

**Placeholders:** `[OUTPUT PATH]` a file under the scratch directory · the rest from the store.
The orchestrator merges `proposed_actors` into `settings.actors` (checking for near-duplicates)
before it applies the processes.
