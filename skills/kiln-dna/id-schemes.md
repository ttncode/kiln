# Project DNA — ID schemes & remap playbook

> **In kiln:** this page is tps-project-dna v2.18.1's text, verbatim. The scripts and files it names
> are that project's; [reading-note.md](reading-note.md) says what each one is in kiln, and where
> the two disagree, kiln's commands win.

Stable, memorable, quantified ids are what let 8,000+ findings, 1,000+ features, and 300+ processes
cross-reference each other without drift. Rules here are load-bearing: several gate-checks depend
on them.

## The schemes

| Thing | Scheme | Example | Rules |
|---|---|---|---|
| Finding | `RD-####` | `RD-8417` | Sequential, append-only, zero-padded to 4+ digits, NEVER reused or renumbered. The corpus's primary key — everything above traces to these. |
| Planned finding | `PRD-####` | `PRD-0001` | Added v2.7.32. A DELIBERATELY SEPARATE namespace from `RD-####` — never sequential against the scan corpus, so a PLANNED finding minted at intake time can never collide with a real `RD-` id a later scan round assigns. `status: "PLANNED"`, no `evidence` yet (a scan round attaches it and clears PLANNED, same lifecycle as a PLANNED Feature/Surface). Sequential only within its own `PRD-` counter, per project. |
| Domain | `DOM-{ABBR}` | `DOM-HDG` | ABBR = 2–4 letter memorable abbreviation of the domain name (MI, EXP, HDG, POS, RSK, GOV, RPT, ADM, OPS). Propose the table, get user sign-off before applying. |
| Capability | `DOM-{ABBR}-XX` | `DOM-HDG-05` | XX = 2-digit sequence within the domain. No separate `CAP-` prefix — capabilities nest under their domain's id. |
| Feature | `DOM-{ABBR}-XX-YY` | `DOM-HDG-05-02` | YY = 2-digit sequence within the capability. New features take the next free YY (max existing + 1); gaps from history are fine, never re-packed. |
| Flow / Stage / Process | `BF-NN` / `BF-NN.S#` / `BF-NN.S#.P#` | `BF-06.S2.P3` | Same nest-under-parent principle, dot-separated. |
| Update round | `UPD-YYYY-MM-DD-NN` | `UPD-2026-07-23-01` | NN = sequence within the day. Lives in `_update_history.json`. |
| Intake round | `INTAKE-YYYY-MM-DD-NN` | `INTAKE-2026-08-03-01` | NN = sequence within the day. Lives in `_intake_ledger.json` (the `tps-quantification-intake` skill, forward direction). CONFIRMED rounds only; applied mechanically by `scripts/apply_intake.py` (v2.5.0). |
| Debt | `DEBT-YYYY-MM-DD-NN` | `DEBT-2026-08-11-01` | NN = sequence within the day. Lives in `_debt_ledger.json`. A `SETTLED` entry cites the settling `UPD-` round id in `settled_by` (gate-checked). |
| Release round | `REL-YYYY-MM-DD-NN` | `REL-2026-08-11-01` | NN = sequence within the day. Lives in `_release_ledger.json`. |
| Service | `SVC-{MNEMONIC}` | `SVC-BE` | MNEMONIC = short UPPERCASE memorable code, from `_infra_map.json`. Stable forever once cited — findings carry a DERIVED `service_id` pointing at it. |
| Surface | `SRF-{MNEMONIC}` | `SRF-HEDGE-API` | Same MNEMONIC rules (uppercase, stable forever once cited); carries its owning `service_id`. |
| Rule (rule catalog) | domain-scoped short ids | `C-08` | Only unique within a domain — any rule→ticket/evidence matching MUST be domain-scoped or ids collide across domains. |

Principles: ids **nest** (a feature id tells you its capability and domain at a glance); ids are
**quantified** (counts and sequences, no random hashes); ids are **stable** (a rename of the thing
never changes its id; an id remap is its own heavyweight event, below).

## Deep-link routing

Every HTML report supports hash routing so ids are addressable from anywhere:
`#domain=DOM-HDG` · `#capability=DOM-HDG-05` · `#feature=DOM-HDG-05-02` · `#process=BF-06.S2.P3`.
Handle on load AND on `hashchange`; write the hash back as the user navigates so F5 returns to the
same spot. Cross-report links are plain `<a href="other-page.html#feature=...">`.

## Provenance layering (multi-era history without clobbering)

When ids or names change era, each era's prior identity is preserved in its own field layer:

- `legacy_*_id` / `legacy_name` — identity from an OLDER era (era N-2 or earlier). Frozen; never
  overwritten by a later remap.
- `previous_*_id` — identity from the immediately-prior era (era N-1). A new remap moves nothing:
  it writes the *current* id into a NEW `previous_*` value and leaves `legacy_*` untouched.
- `merged_from` / `split_from` — structural provenance when nodes were combined or decomposed.

Never reuse an existing provenance field for a new remap — if `legacy_feature_id` already holds the
18-domain-era id, the next remap introduces `previous_feature_id` rather than overwriting it.
**A node's FIRST remap writes `legacy_*`** (clarified v2.1.0 — with only one prior era there is no
N-2/N-1 distinction yet; `previous_*` enters the picture on the second remap).

**Carry an `id_history` LIST alongside, and read the list — never the scalar — when re-keying
(added v2.14.0, from three separate failures in one round).** The scalar fields are written with
`setdefault`, so after a second remap `legacy_process_id` still names the ERA-0 id. Anything that
needs "what was this called immediately before?" — re-keying a sidecar, matching an external
artifact, tracing one round — needs era N-1, and reading the scalar hands it era-0 instead. So
append every rename to `id_history`; `id_history[-1]` is era N-1 by construction. Three concrete
failures, all in the same round:

1. A sidecar re-key derived its map from `legacy_process_id`, got era-0, and reported 17
   unresolved keys and 18 processes with no diagram. Its bijection gate caught it.
2. Rewritten to compare two write-model snapshots instead, it worked once and then went stale the
   moment a third round ran — the "right" backup to compare against is not knowable from inside
   the script. Provenance on the node is; snapshots are not.
3. Falling back from `id_history[-1]` to the scalar when the history is empty is worse than
   failing: **after a compaction an era-0 id can be another node's CURRENT id**, so the fallback
   silently overwrites that node's entry. Gate for it — a rename whose target is still a live key
   in the file being re-keyed is always a bug.

Two more remap rules the same round produced:
- **Historical-provenance fields are exempt from BOTH the remap and the dangling-reference
  audit.** `merged_from`, `split_from`, `moved_from_stage`, `id_history`, `legacy_*` all name
  nodes that no longer exist — that is their purpose. An audit that walks them reports correct
  history as 18 broken links (step 6 already allows them as historical contexts; the exemption
  belongs in the code, not only in the prose).
- **Normalise the id key before reading.** One Flow carried its id under `flow_id` while the other
  eleven used `id`, because a different round's split path minted it. Every consumer reading only
  `id` skipped that Flow in silence — no error, just one twelfth of the axis missing.

## ID remap playbook (validated twice on the reference project)

1. **Confirm the scheme with the user first** (exact format + the abbreviation table) via explicit
   question, before touching data.
2. **Investigate which files/fields are live** — grep every generator for what it actually reads;
   distinguish live inputs from dead artifacts and from other pipelines' separate namespaces.
   Validate format assumptions against the real data (max sequence numbers fit the digit budget).
3. **Mechanical transform** — if the old id's structure encodes the new id (usually true), a pure
   regex `remap_id()` beats a lookup table. Backup every file first (`.pre_<event>_backup.json`).
4. **Gate-check**: old→new is a 1:1 bijection (no collisions, none dropped); node counts conserved;
   every live field matches the new format by regex; cross-axis references all resolve (a process's
   `primary_capability_id` must resolve to a capability actually owned by its `primary_domain_id`);
   zero dangling relationship/feature references.
5. **Regenerate everything**, including hand-maintained pages (they hardcode ids in JS data).
6. **Sweep the rendered output — `python scripts/sweep_ids.py --dna <project-dna>` (v2.14.0).**
   This step is the one that gets skipped, and it is the one that matters: it is the only check
   that looks at what a READER will actually see rather than at what the write-model says. It was
   prose in this list for four versions and was skipped twice in a single round by an operator who
   had read it, because nothing failed when you stopped at step 5. It is now a script with an exit
   code — run it, and treat a non-zero exit as the round not being finished.
   Its first real run found 4,654 dead references, including 153 ids buried in the BODIES of 241
   process diagrams (the sidecar re-key had rewritten their file KEYS and left each diagram's own
   `title <id> -- <name>` line naming a process from two rounds ago) and a Feature's
   `capability_id` back-reference that the taxonomy split had never remapped. Every count
   reconciled and every other gate passed in both cases; the only visible symptom was a rendered
   report listing 28 flows for a 12-flow store.
   The rule it enforces is unchanged: every
   remaining old-format id must sit under a known historical field name (`legacy_*`, `previous_*`,
   `merged_from`...) — anything else is a missed live field. **Allowed historical-narrative
   contexts (v2.1.0):** old ids QUOTED inside frozen prose are correct, not strays — audit-round
   working notes/reasoning text (a historical record describes the tree as it stood; never rewrite
   it), `_meta` history notes, `added_by`/`retired_by` annotations, and the round's own old→new
   remap table in `_update_history.json`. The sweep must classify every hit into live-field vs one
   of these contexts and fail only on the former.
7. Record in the progress log with the full old→new table.
