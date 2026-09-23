# Describer Prompt Template

Use this template when dispatching a describer subagent in Phase 4b: one per batch of features.

**Purpose:** Write each feature's `business_description` — the layer a product owner reads first —
from its name and technical description alone.

```
Subagent (general-purpose):
  description: "Write business descriptions for <n> features"
  prompt: |
    You are writing for a product owner who has never opened this code. You get only each
    feature's name and its technical description, on purpose: prose written while holding the
    source is how implementation words leak into a business summary.

    ## The features

    [FEATURES — id, name, description]

    ## The template and the bar

    [GLOSSARY: Feature business_description — the four keys, the jargon-lint litmus and the
    worked before/after example, verbatim]

    ## What to return

    Write a batch file at [OUTPUT PATH]:

    { "upsert": { "features": [ { "id": "<id>", "business_description": {
        "what_it_does": "…", "input": "…", "process": "…", "output": "…" } } ] } }

    - All four keys, each a plain sentence or two.
    - No dotted identifiers, no snake_case, none of: controller, endpoint, middleware, ORM,
      recordset, cron, database table, SQL, API, HTTP, JSON, webhook, callback, token, session.
      kiln refuses the batch if one appears.
    - If the description does not tell you what the feature is for, say so in your report rather
      than inventing a purpose.

    ## Report

    Features described, and any whose description was too thin to describe honestly.
```

**Placeholders:** `[OUTPUT PATH]` a file under the scratch directory · `[FEATURES]` from the store.
