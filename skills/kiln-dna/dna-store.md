# Project DNA — canonical store (the raw-queryable data contract)

> **In kiln:** this page is tps-project-dna v2.18.1's text, verbatim. The scripts and files it names
> are that project's; [reading-note.md](reading-note.md) says what each one is in kiln, and where
> the two disagree, kiln's commands win.

The **DNA store** is the standardized, cross-project physical format for every pipeline
artifact. Its one design goal: **an agent with nothing but grep/read can answer questions by
walking relationships between objects** — no custom tooling, no per-project parsing knowledge.

Status & roadmap: **v1 = DERIVED** — the store is rebuilt idempotently from each project's
existing working JSONs by `scripts/build_dna_store.py`; those JSONs remain the write-model.
**v2 = write-model** — the pipeline and report engine read/write the store directly (planned
together with the unified report engine). Never hand-edit the store in v1; rebuild it.

## Layout — one file per object type, no intra-type sharding

```
project-dna/_dna_store/
  manifest.json        # router + contract: schema_version, project, pins, counts,
                       # evidence-sources registry, ext-field labels
  domains.jsonl        # one JSON object per line, per entity
  capabilities.jsonl
  features.jsonl
  excluded.jsonl       # excluded catalog entries (UX patterns / engineering standards)
  findings.jsonl       # the largest file (26k lines / ~13 MB on the biggest project) — fine:
                       # grep does not care, and generators load it whole exactly as before
  flows.jsonl
  stages.jsonl
  processes.jsonl
  edges.jsonl          # ALL cross-object relationships, one edge per line
  updates.jsonl        # update-history rounds
  intakes.jsonl        # intake-ledger rounds (v2.5.0 — see "History & ledgers" below)
  releases.jsonl       # release-ledger rounds (v2.5.0)
  debts.jsonl          # debt-ledger entries (v2.5.0)
  services.jsonl       # System axis: deployable/backing services (v2.5.0 — see "System axis" below)
  surfaces.jsonl       # System axis: service surfaces (screens/APIs/batches/entities) (v2.5.0)
  components.jsonl     # System axis: module tier between service and finding (v2.16.0)
```

The five v2.5.0 collections are all OPTIONAL: on a project without the source files they are
simply empty — older stores and projects need no migration.

Line count is explicitly NOT a reason to shard — splitting by object type keeps report
generation simple (each generator loads exactly the collections it needs, whole).

## Record conventions (the rules that make raw querying work)

1. **One entity per line.** `grep "DOM-HDG-05-02" -r _dna_store/` returns the entity's full
   record plus every line that references it — that IS the query API.
2. **Every record starts with `entity` and `id`.** `entity` is the type tag
   (`domain|capability|feature|excluded|finding|flow|stage|process|edge|update|intake|release|`
   `debt|service|surface`), `id` is the
   canonical id (uniform field name across all types — adapters map `feature_id`/`process_id`/
   `rd_id` source fields into it).
3. **Only IDs cross file boundaries.** Names/descriptions/text live solely on the entity's own
   line; every other file references by id. Ancestor DENORMALIZATION is ids-only: a feature
   carries `capability_id` + `domain_id`; a process carries `flow_id` + `stage_id` (+ its
   `primary_*` ids); a finding carries `feature_id` (nullable; may point to an excluded entry).
   One grep hit therefore carries full addressing context — and renames touch exactly one line.
4. **Provenance rides on the line.** `previous_*`/`legacy_*`/`merged_from`/`split_from` fields
   are preserved verbatim — so grepping an OLD id still finds the current node. Old ids stay
   queryable forever; documents citing them never dangle for an agent.
5. **Project-specific fields are allowed, namespaced.** Anything beyond the core contract goes
   under an `ext` object on the record (adapters move unknown source fields there). Core field
   names are reserved; `ext` keys get display labels via `manifest.ext_field_labels` so the
   report engine can render them generically.

## edges.jsonl — the relationship file

One edge per line: `{"entity":"edge","from":"<id>","to":"<id>","kind":"<KIND>","type":"<T>"}`

| kind | meaning | `type` values |
|---|---|---|
| `TYPED_REL` | typed capability_relationships (both axes) | the closed 8-value set from glossary.md |
| `FEATURE_PROCESS` | a Process's `related_feature_ids` link | — |
| `CONTROLS` | process → its `controls_process_id` target | — |
| `REALIZES` | technical feature → the business feature it realizes | — |
| `TOPOLOGY` | service → service infra link — authored in `_infra_map.json` `edges[]` (v2.5.0), or **derived by hop-lift** (v2.18.0: `derivation: "hop-lift"`, `support` = number of `EXTERNAL_HOP` call sites, `channels`, first call site as `evidence`; an authored edge on the same pair gains `hop_support` instead of a duplicate) | `CALLS` · `READS` · `WRITES` · `PUBLISHES` · `SUBSCRIBES` (closed set; both endpoints MUST be services — gate-checked; hop-lift is always `CALLS`) |

Evidence links are NOT edges (they would add tens of thousands of noise lines): the
feature→finding relation is denormalized both ways instead — `feature.rd_ids[]` and
`finding.feature_id`.

## manifest.json — router + per-project contract

```jsonc
{
  "schema_version": "1.0",
  "dna_methodology_version": "2.0.0",   // which tps-project-dna METHODOLOGY built this (see the
                                         // skill's own CHANGELOG.md) — a different concept from
                                         // schema_version above (that's this STORE FORMAT's own
                                         // contract version). Sourced from the project's own
                                         // dna-store.config.json "methodology_version" field;
                                         // absent -> "unstamped (pre-versioning)".
  "project": "tradom",
  "generated_at": "...", "source_pins": {"backendsource": "fdafa754e", ...},
  "counts": {"findings": 8417, "features": 1052, ...},   // gate-checked against recount
  "evidence_sources": [                                   // ← per-project heterogeneity lives HERE
    {"id": "code-be", "kind": "SOURCE_CODE",   "root": "SOURCE/backendsource"},
    // "stack" (v2.7.6, OPTIONAL, additive) — declares which STACK ADAPTER bootstrap_dd_sources.py's
    // menu/ui/api/funcs extractors and bootstrap_infra_map.py's screen detection should use for
    // THIS source, instead of the default Odoo/Python-shaped path. Absent -> unchanged Odoo
    // behavior. Registered adapters: "vue3-router" (menu extractor only, so far — see
    // references/proposals/2026-08-17-vue-spring-dd-extractors.md for "spring-mvc", still
    // PROPOSED). Add a new adapter the same way build_dna_store.py's "adapter" field works: a
    // project either matches a known stack or a new one is added to the shared script.
    {"id": "code-fe", "kind": "SOURCE_CODE",   "root": "SOURCE/frontsource", "stack": "vue3-router"},
    {"id": "jira",    "kind": "ISSUE_TRACKER", "link_template": "https://jira.../browse/{ref}"},
    {"id": "gitlab",  "kind": "COMMIT",        "link_template": "https://gitlab.../-/commit/{ref}"},
    {"id": "doc",     "kind": "ONLINE_DOC",    "link_template": "https://.../{ref}",
     "is_spec": true, "scope": "project"},
    {"id": "vendor-doc", "kind": "ONLINE_DOC", "link_template": "https://.../{ref}",
     "is_spec": true, "scope": "platform"}
  ],
  "ext_field_labels": {"grounded_in_odoo_category": "Odoo category"}
}
```

**Evidence references** on records are source-relative, never hard URLs:
`{"src": "code-be", "ref": "services/HedgeService.java", "loc": "L120"}`. The registry's
`link_template`/`root` turns them into links at render time; `is_spec: true` marks which
sources count as "documentation" for the CODE_ONLY/COVERED/PARTIAL_MISMATCH semantics — this
generalizes the category definitions across projects that have local docs, online docs, Jira,
or nothing at all.

**`scope` — platform vs. project spec** (optional per source, default `"project"`). A source
being a written document does not by itself mean it documents what THIS project built. A project
forked/customized from an open-source or vendor base (e.g. Odoo) inherits that base's own
official docs — those describe the generic upstream product, not the client-specific
customizations layered on top. Citing them as evidence is fine (real, useful reference), but they
must never drive a COVERED verdict for a Feature that is actually a project-specific addition. Two
values: `"platform"` (vendor/open-source/upstream docs — reference-only, excluded from
COVERED/PARTIAL_MISMATCH scoring regardless of `is_spec`) vs `"project"` (this project's own
authored spec — tickets, Confluence, internal design docs, legacy hand-authored docs — genuinely
proves intent, eligible for COVERED when `is_spec: true`). Only `is_spec: true` sources with
`scope: "project"` (the default) should ever count toward COVERED; a `scope: "platform"` source
renders as a reference link but never upgrades a finding's classification. New source kinds
(Confluence, wikis, ticket systems beyond Jira, whatever future projects bring) slot into the
registry the same way — the registry is intentionally open, only `kind`/`scope` carry reserved
meaning.

## History & ledgers (v2.5.0)

`updates.jsonl` is no longer the only round family. Three shared LEDGER files feed the store,
loaded adapter-INDEPENDENTLY (`_load_shared_ledgers` in the builder — the ledgers share one
canonical shape across all projects, so they never live in an adapter; per-project path overrides
via the config `paths` keys `intake_ledger` / `debt_ledger` / `release_ledger` / `infra_map`):

| Source file | Collection | Source shape | Core fields |
|---|---|---|---|
| `_intake_ledger.json` | `intakes.jsonl` | `{"rounds": [...]}` — one CONFIRMED intake round per entry (the `tps-quantification-intake` skill) | `entity, id, date, ticket, title, verdicts` |
| `_debt_ledger.json` | `debts.jsonl` | `{"entries": [...]}` (`debts` accepted as a fallback key) | `entity, id, date, kind, status, cites, owed, settled_by, source` |
| `_release_ledger.json` | `releases.jsonl` | `{"rounds": [...]}` | `entity, id, date, status, title, features, services` |

`verdicts` on an intake round is CORE, not `ext` — it is the machine-consumable heart of the round
(the `proposed_id`s the PLANNED-trace gate reads). This is load-bearing: during v2.5.0 testing a
real bug was caught when `verdicts` fell to `ext` and the gate went blind to every reserved id.

**Debt entries** record what a round OWES the DNA rather than what it did. `kind` ∈
`HOTFIX | MAP_OUTDATED | UNRULED_AREA` and `status` ∈ `OPEN | SETTLED` are closed vocabularies
(meanings in glossary.md; enforced by BOTH the builder and `check_gates.py`). A `SETTLED` debt must
cite the real `UPD-` round id that settled it in `settled_by` — gate-checked against
`updates.jsonl`. Every update round must walk the OPEN debts (update-playbook.md § 4c).

**REL rounds** (`REL-YYYY-MM-DD-NN`) record release events — which `features` shipped and which
`services` deployed, with `status` and `title`. The explorer's History tab merges all three round
families (`UPD-` / `INTAKE-` / `REL-`, newest first) plus an open-debts section.

## System axis (v2.5.0 as "Infra axis"; named the System axis in v2.16.0)

The third axis, beside Capability (`DOM-*`) and Process (`BF-*`). It answers **what the system is
made of**, where the other two answer what the business can do and how work flows:

| | Capability axis | Process axis | System axis |
|---|---|---|---|
| Nodes | domain → capability → feature | flow → stage → process | service → **component** → surface |
| Ids | `DOM-*` | `BF-*` | `SVC-*` / `CMP-*` / `SRF-*` |

Named "System", not "Infra", because it holds application modules, datastores, external services
and batch surfaces — not deployment plumbing, which is what "infra" reads as. The file keeps its
`_infra_map.json` name (renaming a generator input breaks scripts and buys nothing); it is the
System axis' **bootstrap input**.

`project-dna/_infra_map.json` (optional, adapter-independent) describes the project's physical
topology — the axis findings live ON, as opposed to the business axes they describe:

```jsonc
{
  "services": [{"id": "SVC-BE", "name": "Backend", "kind": "BACKEND",
                "tech_stack": ["java", "spring"], "repo": "backendsource",
                "root_paths": ["backendsource/src"], "module_keywords": ["hedge"]}],
  "surfaces": [{"id": "SRF-HEDGE-API", "service_id": "SVC-BE",
                "name": "Hedge API", "kind": "API"}],
  "edges":    [{"from": "SVC-FE", "to": "SVC-BE", "type": "CALLS"}]
}
```

- `services[]` → `services.jsonl` (core: `entity, id, name, kind, tech_stack, repo, root_paths,
  module_keywords`). `kind` closed: `FRONTEND | BACKEND | DATABASE | SEARCH | QUEUE | CACHE |
  GATEWAY | EXTERNAL` (glossary.md defines each). An EXTERNAL service's `root_paths` is the
  module that WRAPS it (`payment_paypal/`, `web_unsplash/`): findings inside carry
  `service_id` = that EXTERNAL service (attribution), while the caller of the module's outbound
  calls is the service CONTAINING it — hop-lift resolves the caller with the callee excluded.
- `surfaces[]` → `surfaces.jsonl` (core: `entity, id, service_id, name, kind`). `kind` closed:
  `SCREEN | API | BATCH | ENTITY`; `service_id` must resolve to a real service.
- `edges[]` → `edges.jsonl` records with `kind: "TOPOLOGY"` — closed `type` set, service
  endpoints only (see the edges table above). Since v2.18.0 the builder ADDS derived `TOPOLOGY`
  edges from `process_external_hops` (hop-lift: caller = the service whose `root_paths` own
  the cited file, segment-aware; callee = the hop target; type `CALLS`) — so the authored list
  only needs what no call site proves (data-store `READS`/`WRITES`, async `PUBLISHES`/
  `SUBSCRIBES`, frontend → backend). Two reachability gates then hold the map honest: every
  `EXTERNAL` service must have an inbound `TOPOLOGY` edge once the store has any topology data
  (a service is in the map BECAUSE something calls it), and every `FRONTEND`/`BACKEND`/`GATEWAY`
  service must declare `root_paths` or `module_keywords`. `scripts/topology_round.py` drafts
  the fix for a red gate from the evidence that discovered the service (update-playbook.md §4d).
- `components` (v2.16.0, optional) → **the only authored input to the component tier**:
  `{"components": {"custom": ["iam_auth", "prd_product_master"]}}` marks which module roots the
  project owns. Everything else about a component is derived; an absent key means every component
  is `origin: VENDOR`, which is the honest reading for a store built from a vendored platform.

### Component tier (v2.16.0)

`components.jsonl` fills the gap between `services.jsonl` (container granularity — a handful of
records) and `findings.jsonl` (statement granularity — tens of thousands): the **module**, which is
the unit humans name, reuse, review and release. Measured on the Odoo reference store: 14 services
vs 586 module roots — a 65× granularity gap that no entity covered.

- Core fields: `entity, id, service_id, name, kind, origin, module, finding_count, surface_ids,
  feature_ids`. `kind` closed: `ADDON | FRAMEWORK | PROJECT`. `origin` closed: `CUSTOM | VENDOR`.
- `id` = `CMP-` + the module root uppercased with non-alphanumerics collapsed to `-`
  (`iam_auth` → `CMP-IAM-AUTH`). The literal path stays in `module`; the id is never parsed back.
- **Fully derived, never hand-edited** (`_derive_components`), so it is rebuilt and diffed every
  round like any other derived artifact (Core Principle 11). Derivation is literal, three rules:
  a path containing an `addons/` segment → the next segment (`ADDON`); else `<repo>/odoo/<sub>` →
  `odoo/<sub>` (`FRAMEWORK`); else the first two segments (`PROJECT`).
- **`finding.component_id` is DERIVED** alongside it, mirroring `service_id`/`surface_id` — with
  one deliberate difference: there is no ambiguity blank. A finding's module path *is* its
  component by definition, so a blank means the finding lost its `module` field, which the gates
  treat as a regression rather than a tolerance.

This is a component **identity** tier. It does not reopen the standing ban on module-level
*derivation tiers for edges* (2026-08-13, re-affirmed 2026-08-15): no edge is claimed from module
names here — the value transcribed is the one each finding already states in its own `module`
field.

**`finding.service_id` is DERIVED, never hand-set** (`_derive_service_ids` in the builder): the
longest matching `root_paths` prefix on `finding.module` (backslash-normalized) wins;
`module_keywords` are the fallback and bind only when exactly ONE service matches; any remaining
ambiguity leaves the field unset — an honest blank beats a guessed wrong home. `check_gates.py`
verifies every set `service_id` resolves to a real service.

## DD evidence layers — `_dd_sources/` + two new source kinds (v2.6.0)

Two additional `evidence_sources` kinds (registry semantics unchanged, default
`scope: "project"`): **`DEPLOY_CONFIG`** (docker-compose / k8s / CI manifests — feeds
service + dependency-edge suggestions for `_infra_map.json`) and **`DATABASE_SCHEMA`**
(a dev-DB introspection dump, opt-in via config, never auto-connected — column-level truth
where ORM declarations don't cover).

`scripts/bootstrap_dd_sources.py` drafts the DD evidence layers mechanically (declaration-
shape greps, git-grep fast path, 0 LLM tokens): `ui` (view/form field skeletons — the
machine half of a screen-item spec), `db` (ORM column declarations; v2.7.0 adds per-column
constraint/selection/relation/default args + per-file SQL constraints), `api` (NEW v2.7.0 —
HTTP endpoint registry from route decorators: path/type/auth/methods/function, route
registry only), `err` (error-code registry; v2.7.0 adds per-site exception class, literal
message, enclosing function for route files, explicit HTTP status only), `i18n` (.po
inventory per module x language), `deploy` (compose/k8s services + depends_on edges, both
yaml shapes). Output: `project-dna/_dd_sources/<name>.draft.json` — DRAFTS a human reviews;
the KB3 DD renderer consumes the reviewed files directly. NOTHING is promoted into the core
store (schema-after-data rule): the extracts stay draft-side; any store collection for
these layers remains a separate gated decision after field validation (the one open
proposal is the SCREEN↔API surface edge — `references/proposals/`).

**Boundary (station discipline):** running `bootstrap_dd_sources.py` is a DNA COLLECTION
activity of this skill — it exists because the DNA is the tracking layer and a missing
evidence kind is a collection gap. Record each run in `_PROGRESS.md` like any scan round
(date, extractor counts, source pin). Downstream stations (the DD renderer, ticket/test
authors) only CONSUME the drafts; they never run collection as a step of producing their
own artifact, and a missing extract is reported back as a DNA gap, not worked around.

## Refactor & evolution story (designed-in, not bolted on)

| Change | Store impact | Mechanism |
|---|---|---|
| Rename (id stable) | exactly 1 line | edit `name`, keep `legacy_name` |
| ID remap (e.g. DOM-01→DOM-HDG) | many lines, but a GATED event | v1: remap the source JSONs per id-schemes.md's playbook, then **rebuild the store** — no in-place surgery. v2: line-oriented mechanical script + the same gates (bijection, dangling-edge check, stray-id sweep) |
| Merge / split | new node lines + provenance | `merged_from`/`split_from` on the node; edges re-pointed mechanically; gates catch orphaned endpoints |
| Schema evolution | additive by default | new OPTIONAL fields never bump the version; breaking changes bump `schema_version` major + ship a converter |

## Builder script — shared, ships with this skill

`scripts/build_dna_store.py` (in this skill's `scripts/`) is the ONE canonical converter —
projects never write their own. Per-project variation lives in a small
`project-dna/dna-store.config.json` (adapter name, source paths, evidence_sources,
ext_field_labels). Known adapters: `tradom-embedded` (capabilities as dict, features embedded)
and `odoo-normalized` (capabilities as list, features/excluded in separate files). A new
project either matches a known shape or adds an adapter to the shared script — the improvement
flows back to every project, like every other skill asset.

Builder gate-checks (assert-hard, printed pass/fail): counts conserved vs sources; ids unique
per file; referential integrity (every denormalized ancestor id resolves; every edge endpoint
exists; every `finding.feature_id` resolves); manifest counts equal a fresh recount of the
written files. v2.5.0 adds (mirrored in `check_gates.py` gates 6b/6c/6d): feature `status` closed
vocab (`PLANNED` or absent); PLANNED ⇒ empty `rd_ids`; every PLANNED feature traces to an intake
round's `proposed_id` (no orphan reservations); debt `kind`/`status` closed + SETTLED cites a
real update round; service/surface `kind` closed + `surface.service_id` resolves; TOPOLOGY edges
have closed types and service-only endpoints; `finding.service_id` resolves when set. v2.18.0 adds
(mirrored in `check_gates.py` 6h): hop-lift edges are `CALLS` with `support >= 1`; every EXTERNAL
service is reachable (inbound TOPOLOGY edge) once any topology data exists — the builder ABORTS on
this one, so an unreachable service blocks the rebuild until update-playbook.md §4d resolves it;
FRONTEND/BACKEND/GATEWAY services declare `root_paths` or `module_keywords`.

**`scripts/apply_intake.py` (v2.5.0)** is the ONE mechanical write path for id reservations —
nobody hand-edits the capability map for a reservation, ever. It reads a CONFIRMED round from
`project-dna/_intake_ledger.json`, dry-runs by default (prints the stubs it would insert and
where), and with `--apply` backs up the write-model (adapter-aware: `odoo-normalized` appends to
`_bc_features.json`; `tradom-embedded` appends into the parent capability's embedded
`features[]`), inserts `status: PLANNED` stubs, rebuilds the store, runs `check_gates.py`, and
RESTORES the backup automatically if the build or gates fail. Idempotent: an already-present id
is SKIPped, never inserted twice.

## Store Explorer — the shared human viewer

`assets/explorer.html` is an **immutable static template** (never generated, never copied per
project) that renders ANY conforming store: overview counts from the manifest, drill-down on
both axes, a generic detail panel (fields / evidence chips / relationships from edges /
provenance / `ext` fields labeled via the manifest), search, and `#id=<any id>` deep links.
It fetches `_dna_store/*.jsonl` at runtime — findings lazily, so a 26k-finding store opens
instantly. The **Infra tab** (`#/infra`, v2.18.0) shows the System axis: a Services graph
rendered by the vendored `laneflow.js` (authored TOPOLOGY edges solid, hop-lift dashed, kind
icons, click a node to open it), Surfaces folded by kind (a row opens a copyable detail dialog,
not a page), and the service detail card answers the hub questions — who calls it / whom it
calls with the cited call site, which business processes depend on it (`EXTERNAL_HOP` grouped
by flow), and its footprint (surfaces by kind, components, findings). Because browsers block
fetch on `file://`, launch it with the one-click server:

```
python <skill>/scripts/serve_store.py <dir-containing-_dna_store>
```

which serves the project directory AND the template straight from the skill (always the latest,
no stale copies); `--copy` materializes copies (explorer.html + laneflow.js) next to the store
for static hosting instead.

**`assets/View DNA Report.bat`** wraps that exact command into a double-clickable launcher —
copy it to the project's own root (bootstrap-playbook.md Phase 0 does this automatically for new
projects; for one already bootstrapped before this asset existed, copy it once by hand). No
terminal needed: double-click it, the console window that opens IS the running server (closing it
stops the server), the browser opens itself. This is the one non-technical people should be
pointed at — never hand someone a raw `python ...` command to view a report.

Validated on both reference projects with zero template changes
between them — the first working proof of the "one platform template, N project data sets" model.

Beyond browse/search/detail, the explorer computes three report views LIVE from the store:
- **Matrix** — coverage matrix (Domain×Flow / Capability×Flow toggle), cells = process counts,
  click-to-drill; pure aggregation over `processes.jsonl`.
- **Diagram** — per-flow LaneFlow swimlanes generated client-side from `process_kind`,
  `controls_process_id`/`decision_branches` (added v2.4.0 wording — real decisions render as
  diamonds, see diagramming.md) and the CONTROLS edges. Lane placement uses the project's audited actor
  taxonomy if the store config provides it (optional `diagram` block in
  `dna-store.config.json`: `lanes`, `lane_priority`, `default_lane`, `actor_keywords`,
  `actor_overrides`, `sequence_overrides` — copied into the manifest by the builder); with no
  config it falls back to generic Processes/Controls lanes. Clicking a node opens its detail.
- **History** — v2.5.0: the whole round family merged into one list — scan rounds (`UPD-`),
  intake rounds (`INTAKE-`), release rounds (`REL-`), sorted by date desc — plus an "open debts"
  section (OPEN entries from `debts.jsonl` only).

v2.5.0 explorer behavior: the five new collections are eager-loaded (a missing file yields an
empty collection, so older stores render fine), and a feature with `status: PLANNED` shows an
amber PLANNED badge in EVERY list it appears in — a reservation is not evidence-backed fact, so
RESERVED never masquerades as REAL.

### One UI, two data sources (v2.15.0)

The template reads **`window.__DNA_EMBED` if it is present, and falls back to `fetch` when it is
not**. That single branch is the whole static-export design. The page served by `serve_store.py`
finds no embed and fetches the live store, so it is always current; the exported page finds the
embed and never touches the network, so it opens from a double-click or an email attachment with
no server, no `.bat` and no sibling files.

**There is exactly one copy of the UI.** A hand-written "static version" is a fork, and a fork
rots invisibly: the served page gains a feature, the exported one does not, and nobody notices
until a reader believes a stale export. So the exporter takes the template *verbatim*, injects
the payload ahead of its script tag, inlines `laneflow.js` in place of its `<script src>`, and
changes nothing else. Every future UI change reaches the next export for free.

Two ways to produce one, because a reader with the page open has no terminal:

```
python <skill>/scripts/export_static_explorer.py --dna <dir-containing-_dna_store>
```

and the **Export HTML** button in the page's own header.

Two implementations of one format is exactly the drift the single-UI rule exists to prevent, so
it is not left to discipline — **`scripts/check_export_parity.py` runs both over the same store
and diffs the bytes.** It runs the browser half under Node, so no browser is needed; with Node
absent it reports SKIPPED rather than passing quietly, because a gate that silently does nothing
is worse than none. Everything that gate has caught so far was invisible by eye and fatal in
effect: a literal closing script tag inside a JS string *and inside the comment explaining the
hazard* (which cuts the page's own script in half), `lastIndexOf('<script>')` landing inside one
of those strings, Python's default JSON separators against `JSON.stringify`'s, and a store
checked out with CRLF. Run it after ANY change to the template.

**`scripts/check_explorer_compat.py`** is the other half. The template is shared and immutable,
so the day it throws on a field only newer stores carry, EVERY older project's report goes blank
at once — and blank is what the reader sees, not a stack trace. It loads the page under Node
against five reduced older store shapes (no catalog side; pre-`bpm_review`; pre-
`classification_confidence`; flows keyed `flow_id`; a file with a truncated line and unparseable
JSON) and fails a fixture that renders an empty tree even when nothing was raised — silently
rendering nothing is the failure most likely to be mistaken for a pass.

## Query cookbook (grep is the API)

> **Before writing ANY query: read `references/dna-erd.md`** — the store's object model (entities,
> key fields, edge kinds) plus the trap list of real field-shape incidents (evidence-is-a-sentence,
> nested business_description, TYPED_REL endpoints). Guessing a field shape instead of checking the
> ERD is how every one of those incidents happened.

| Question | Command |
|---|---|
| **Find the id when you only have a name/concept** (e.g. an incoming ticket says "Product Category Maintenance", not a known id) | `grep -il "product categor" _dna_store/*.jsonl` to find which files hit, then `grep -i "product categor" _dna_store/features.jsonl _dna_store/capabilities.jsonl _dna_store/processes.jsonl` — case-insensitive substring against `name`/`description`/`purpose` text. This is the entry point for placement research (quantification intake, "what already covers X?") — start here, never by writing a parsing script against the raw nested `_bc_capability_map.json`/`_bp_process_map.json`; those files exist for the apply step, not for search. |
| Everything about feature X | `grep -r '"DOM-HDG-05-02"' _dna_store/` |
| Just its record | `grep '"id": "DOM-HDG-05-02"' _dna_store/features.jsonl` |
| Which processes use it | `grep '"to": "DOM-HDG-05-02"' _dna_store/edges.jsonl` (kind FEATURE_PROCESS: from=process) |
| Its evidence, with code locations | get `rd_ids` from the record → `grep '"id": "RD-8290"' _dna_store/findings.jsonl` |
| Reverse: which feature owns finding RD-8290 | same line — `feature_id` is on it |
| Which features own file X (impact of touching one source file) | `grep -F '"services/HedgeService.java"' _dna_store/findings.jsonl` — findings carry `module` + `feature_id`; project `feature_id` from the hits for the owning-feature set |
| All CONTROL processes in a flow | `grep '"flow_id": "BF-10"' _dna_store/processes.jsonl \| grep '"process_kind": "CONTROL"'` |
| Everything a capability TRIGGERS | `grep '"from": "DOM-HDG-05"' _dna_store/edges.jsonl \| grep TRIGGERS` |
| A node by its PRE-REMAP id | `grep -r '"CAP-04.04"' _dna_store/` — provenance fields hit |
| Impact-set seed for a change to X | union of the first three queries above |
| Field projection without flooding context | pipe any of the above into `python -c "import sys,json;[print(json.loads(l)['name']) for l in sys.stdin]"` |
| **Multiple known ids at once** (added v1.5.0 — a real query that broke, see below) | `grep -E '"id": "(DOM-PLT-21\|DOM-PLT-22\|DOM-PLT-23)"' _dna_store/capabilities.jsonl` — one `grep -E` with alternation, still ONE command, still no custom script; do not write a loop over `open(...).readlines()` for a known id LIST any more than for a single known id |
| **Business-facing description text** (added v1.5.0) | `business_description` is a NESTED object, not a flat field — `{"what_you_can_do": "...", "who_uses_it": "...", "business_outcome": "...", "boundary": "..."}` for a Capability (`CAP_BD_KEYS` in `check_gates.py`), `{"what_it_does": "...", "input": "...", "process": "...", "output": "..."}` for a Feature/Surface (`BD_KEYS`). A field-projection script that does `d.get('description')` or `d.get('what_it_does')` at the TOP level will silently return nothing and look like the record has no description — it does not exist there. Project it correctly: `python -c "import sys,json;[print(json.loads(l)['id'], json.loads(l).get('business_description',{}).get('what_you_can_do','')) for l in sys.stdin]"` |

Caution for agents: records can be long lines (a process with 40 rules). Prefer projecting the
fields you need (last recipe) over dumping whole matches into context.

**A real failure this cookbook is written to prevent** (2026-08-19): an agent needed the
descriptions of 6 known capability ids, wrote a custom `python3 -c` loop over
`open('capabilities.jsonl')` guessing at top-level field names instead of using the two recipes
above — the guess was wrong (`business_description` is nested), so every result printed an empty
description, the agent didn't notice, and the whole detour cost 2+ minutes for what a single
`grep -E` line would have answered correctly in one shot. If you catch yourself about to loop over
an open()'d file with a field-name guess, that is the exact moment to stop and use this table
instead — not just for a single id, for the multi-id and nested-field cases too.
