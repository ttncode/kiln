# Scanner Prompt Template

Use this template when dispatching a scanner subagent: one per batch skeleton that
`kiln dna scan --out` wrote.

**Purpose:** Read a group of source files at a pinned commit and return every business-meaningful
behavior in them as findings, in the skeleton itself.

```
Subagent (general-purpose):
  description: "Scan <n> files for DNA findings"
  prompt: |
    You are reverse-engineering what a codebase does, in business terms, from its source. Your
    output is evidence: another agent will build a business map on it, and a person will trust
    that map because every claim traces back to the lines you cite.

    ## Your batch

    The skeleton at [SKELETON PATH] lists your files under `read`: `path` is the file's name in
    the repository, `at` is where to read it (sometimes a copy of the pinned commit — read that,
    not the working tree), `chunks` are line ranges to read a long file in. Read every file,
    every line.

    ## What to write

    Add findings to `upsert.findings` in that same file. Change nothing else in it — `scan`
    records what was read, and editing it falsifies the record. Each finding:

    - `proposition` — ONE sentence stating a behavior in business language: what the code does,
      not how. "An order over the credit limit is held for approval", not "checkCredit() returns
      false when total > limit".
    - `category` — one of `CODE_ONLY`, `COVERED`, `PARTIAL_MISMATCH` ([GLOSSARY: Finding
      category]). With no documentation in [DOC SOURCES], every finding is `CODE_ONLY`.
    - `module` — the file's `path` (never its `at`).
    - `evidence` — `[{ "src": "<repository name>", "ref": "<path>", "loc": "L<from>-L<to>" }]`,
      the lines that show it. Quote the guard's own predicate in `quote` when the sentence says
      only, never, always, cannot or must: the sentence may claim exactly what the predicate
      supports and no more.

    One behavior per finding. A file with nothing business-meaningful (pure wiring, a DTO) gets
    no finding, and that is a correct answer.

    ## A file that changed since it was last read

    An entry with `was` was scanned before. Read what changed, not the whole file, with the
    entry's own fields: `git -C <repo> diff <was> <commit>:<repo_path>` — a module's history is
    in the module, under its own paths. Its `cites` are the
    findings already describing it; fetch each with `grep <id> .kiln/dna/store/findings.jsonl`.

    - A cited finding whose behavior changed: upsert it by its `id` with the new proposition and
      evidence.
    - New behavior: a new finding, as above.
    - A cited finding the change made untrue: do not touch it — list it in your report with the
      diff lines that retire it.

    ## Before you phrase a finding from a repository, service, store or client class

    Check whether it is one of several implementations of the same interface (a sibling named
    InMemory/Mock/Fake/Stub/Test beside a real one). If it is, the proposition says which variant
    it describes. A test double worded like the real behavior is the error this check exists for.

    ## Rules

    - Business nouns in propositions; code identifiers belong in `evidence`.
    - Do not guess what a called function does — read it, or say "calls X" plainly.
    - Write the file as valid JSON.

    ## Report

    One line per file: path, findings written. Then anything you could not read or judge.
```

**Placeholders:** `[SKELETON PATH]` absolute path of the skeleton · `[GLOSSARY: Finding category]`
paste that section of glossary.md verbatim · `[DOC SOURCES]` the `settings.evidence_sources` whose
`is_spec` is true, or "none".
