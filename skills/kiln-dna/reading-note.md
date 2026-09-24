# Reading the methodology pages in kiln

The pages beside this one — [glossary.md](glossary.md), [id-schemes.md](id-schemes.md),
[quality-gates.md](quality-gates.md), [agent-orchestration.md](agent-orchestration.md),
[bootstrap-playbook.md](bootstrap-playbook.md), [update-playbook.md](update-playbook.md),
[dna-store.md](dna-store.md), [dna-erd.md](dna-erd.md) and [bpm-alignment.md](bpm-alignment.md) —
are tps-project-dna v2.18.1's own text, kept word for word under the grant recorded in kiln's
`NOTICE`. They are the method: the definitions, the litmus tests, the order of the phases and why.
They were written for that project's Python scripts and file layout, which kiln does not ship.

**Where a page and kiln disagree, kiln's commands win.** They are what writes the store, and a
batch that follows a page's instruction to edit a file by hand is refused.

## Scripts

| The page says | In kiln |
|---|---|
| `build_dna_store.py` (rebuild the store) | `kiln dna apply <batch.json>` — every write rebuilds the derived fields and runs the gates; `kiln dna build` rebuilds with no change |
| `check_gates.py` | `kiln dna check` — the same gates, plus one that the derived fields on disk are what the records derive to |
| the density-scan scripts, the `ALREADY_SCANNED` ledger | `kiln dna scan` — the ledger is `.kiln/dna/store/scan.json`, keyed by blob, so a changed file is unscanned again by itself |
| `bootstrap_infra_map.py` | `kiln dna infra` — a draft batch, reviewed before it is applied |
| `serve_store.py`, `export_static_explorer.py` | `kiln dna serve` — the explorer on 127.0.0.1 |
| `apply_taxonomy_split.py`, `apply_stage_layout.py apply` | `kiln dna remap <plan.json> [--apply]` — the same plan schema (plus `stage_layouts` and `renumber_flows`), the same gates, dry run by default |
| a one-off `_merge_*.py`, `sweep_ids.py` | a batch: `upsert` with `merged_from` / `split_from` on the survivors, `remove` for what is gone. The dangling-reference and ancestor gates run on every write, so there is no rendered output to sweep afterwards |
| `apply_intake.py` | none. Intake rounds, PLANNED reservations and their gates are part of the contract, and a batch can write them; the intake workflow itself is not part of kiln |
| `context_footprint.py` | `kiln dna footprint <feature-id ...> \| --all-planned` — the same schema-3 JSON; hours are still not computed |
| `apply_stage_layout.py dossiers`, `sidecar` | none: kiln keeps no id-keyed sidecar, and a dossier is the flow's records read from the store |
| `reconcile_5a.py` | `kiln dna reconcile <manifest.json ...> --roster <sheet>` — the same manifest schema, result and escalation rule |
| `check_bpm.py`, `build_panel_dossier.py`, `topology_round.py`, `render_*.py`, `bootstrap_dd_sources.py`, `check_export_parity.py`, `check_explorer_compat.py`, `migrate_project_dna_rename.py` | none. Where a page says to run one, do by reading what it would have checked — the store is grep-able by design ([dna-store.md](dna-store.md)) — and record what you found in the round's update record |

## Files

| The page says | In kiln |
|---|---|
| `project-dna/`, `_dna_store/` | `.kiln/dna/store/` |
| `project-dna/domain-dictionary-*.md` | `.kiln/dna/domain-dictionary-*.md` — beside the store, written by hand |
| `dna-store.config.json` | `settings` in a batch (`project`, `evidence_sources`, `ext_field_labels`, `diagram`) |
| `_infra_map.json` | the `services`, `surfaces` and `edges` collections; its `components.custom` is `settings.components.custom` |
| `_actor_registry.json` | `settings.actors` — the registry gates run on it |
| `_update_history.json`, `_intake_ledger.json`, `_debt_ledger.json`, `_release_ledger.json` | the `updates`, `intakes`, `debts` and `releases` collections |
| `_PROGRESS.md`, `_findings_ledger.json` | the round's own update record: `notes`, `audit_sample` and `flags` ride on it (under `ext`) |
| the working JSONs (`_bc_*.json`, `_bp_*.json`, `_all_findings.json`) | the store itself — kiln's store is the write model (D153), so there is nothing to derive it from |
| `.pre_<event>_backup.json` | git: the store is tracked, and a round lands through a pull request |

## Skills the pages name

`tps-quantification-intake`, `tps-solution-design` and `tps-quality-benchmark` are sibling skills
of the source project and are not part of kiln. A page that routes work to one is describing a step
kiln does not take.
