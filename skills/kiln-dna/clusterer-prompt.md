# Clusterer Prompt Template

Use this template when dispatching a clusterer subagent: one per capability, or per small batch
of capabilities, in Phase 4.

**Purpose:** Partition the findings proposed for a capability into features — each one
deliverable business ability — and flag, never force-fit, what does not belong.

```
Subagent (general-purpose):
  description: "Cluster findings into features for <capability>"
  prompt: |
    You are building the feature layer of a business map from evidence. Every finding below must
    end up in exactly one place, and a person will read the features you name as the list of
    things this product can do.

    ## The capability

    [CAPABILITY RECORD — id, name, business_description, its domain's core object]

    ## Its sibling capabilities (for `misassigned`)

    [SIBLINGS — id and name of every capability in the store]

    ## The findings

    [FINDINGS — every finding proposed for this capability, full records: id, proposition,
    module, evidence]

    ## The definitions you must use

    [GLOSSARY: Feature, size, business_relevance, delivery_nature, abstraction_level,
    classification_confidence, Excluded catalogs, Identity litmus tests — verbatim]

    ## The project's business vocabulary

    [DOMAIN DICTIONARY — the project's .kiln/dna/domain-dictionary-*.md, verbatim, or "none"]
    Use its standard terms; an alias becomes its standard term; a term marked ⚠ is ambiguous —
    name it in your report instead of choosing a meaning.

    ## What to return

    Write a batch file at [OUTPUT PATH]:

    { "upsert": { "features": [ { "capability_id": "<id>", "domain_id": "<id>", "name": "…",
        "description": "…", "size": "S|M|L|XL", "size_justification": "…",
        "business_relevance": "…", "delivery_nature": "…", "abstraction_level": "…",
        "classification_confidence": "…", "rd_ids": ["RD-…"] } ],
      "excluded": [ { "catalog": "UX|ENGINEERING", "name": "…", "disposition": "…",
        "rd_ids": ["RD-…"] } ] } }

    And the findings that do not belong here in a second file, [FLAGS PATH] — `kiln dna apply`
    takes only the first:

    { "misassigned": [ { "rd_id": "…", "belongs_to": "<existing capability id>", "why": "…" } ],
      "taxonomy_gap": [ { "rd_ids": ["…"], "proposed_capability": "…", "why": "…" } ] }

    - Names state the ability, business-first: no table, component or implementation nouns.
    - `description` is the technical "how it works"; the business description comes later, in a
      separate pass — do not write one.
    - Every finding above appears exactly once across features, excluded, misassigned and
      taxonomy_gap. Count the file you wrote, not your headings.
    - `misassigned`: it fits a DIFFERENT EXISTING capability — name it. `taxonomy_gap`: it fits
      nothing that exists. Keep them apart; never put a finding in the nearest bucket because
      `misassigned` needs a real target.
    - Do not merge distinct abilities because they share a topic or a vendor. If your own
      `size_justification` says "combines", you have probably merged two.
    - Leave `id` out: kiln counts the feature and excluded ids.

    ## Report

    Features written, findings placed per destination, and the count check.
```

**Placeholders:** `[OUTPUT PATH]` the batch and `[FLAGS PATH]` its flags, both under the scratch
directory · the rest as named. The orchestrator applies the batch and handles the flags as the
skill says.
