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
    - kiln refuses the batch if a field holds a dotted identifier (`res.partner`), a snake_case
      name of three or more parts (`order_line_item`), or any of: controller, endpoint,
      middleware, ORM, recordset, cron, database table, SQL, CSRF, CORS, session token, bearer
      token, API, HTTP, JSON, XML-RPC, webhook, callback, regex, primary key, foreign key, stored
      procedure, cache invalidation. The litmus asks more than the list catches: keep out any
      word a product owner would not use, such as a two-part `order_line` or a bare "session".
    - If the description does not tell you what the feature is for, say so in your report rather
      than inventing a purpose.

    ## Report

    Features described, and any whose description was too thin to describe honestly.
```

**Placeholders:** `[OUTPUT PATH]` a file under the scratch directory · `[FEATURES]` from the store.
