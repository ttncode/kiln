"""Derive a kiln-written store again with tps-project-dna's own Python and diff the result.

The derived fields (a finding's feature, service, surface and component, the components, the
hop-lift edges) are stripped the way `build_dna_store.py` never has them, then recomputed by
its `_derive_*` functions. Exit 0 when kiln and the source agree byte for byte.

Usage: python3 compare.py <store-dir> <tps-project-dna scripts dir>
"""
import contextlib
import io
import json
import sys
from pathlib import Path

COLLECTIONS = ["domains", "capabilities", "features", "excluded", "findings", "flows", "stages",
               "processes", "updates", "intakes", "releases", "debts", "services", "surfaces",
               "components", "edges"]
DERIVED_FINDING_FIELDS = {"service_id", "surface_id", "component_id", "feature_id", "entity"}
COMPARED = ("findings", "components", "edges")


def read_store(store: Path) -> dict:
    data = {name: [json.loads(line) for line in (store / f"{name}.jsonl").open(encoding="utf-8")
                   if line.strip()] for name in COLLECTIONS}
    data["_settings"] = json.loads((store / "settings.json").read_text(encoding="utf-8"))
    return data


def owners(data: dict) -> dict:
    owner = {}
    for feature in data["features"]:
        for rd_id in feature.get("rd_ids") or []:
            owner[rd_id] = feature["id"]
    for excluded in data["excluded"]:
        for rd_id in excluded.get("rd_ids") or []:
            owner.setdefault(rd_id, excluded["id"])
    return owner


def rederive(builder, kiln: dict) -> dict:
    data = json.loads(json.dumps(kiln))
    owner = owners(data)
    data["findings"] = [
        builder.can("finding", finding["id"],
                    {k: v for k, v in finding.items() if k not in DERIVED_FINDING_FIELDS},
                    {"feature_id": owner.get(finding["id"])})
        for finding in data["findings"]]
    data["edges"] = [{k: v for k, v in edge.items() if k != "hop_support"}
                     for edge in data["edges"] if edge.get("derivation") != "hop-lift"]
    data["components"] = []
    data["_component_origins"] = (data["_settings"].get("components") or {}).get("custom") or []
    with contextlib.redirect_stdout(io.StringIO()):
        for step in (builder._derive_service_ids, builder._derive_topology_from_hops,
                     builder._derive_surface_ids, builder._derive_components):
            data = step(data)
    return data


def main() -> int:
    store, source = Path(sys.argv[1]), sys.argv[2]
    sys.path.insert(0, source)
    import build_dna_store

    kiln = read_store(store)
    python = rederive(build_dna_store, kiln)
    differing = [name for name in COMPARED
                 if json.dumps(python[name], sort_keys=True) != json.dumps(kiln[name], sort_keys=True)]
    for name in differing:
        print(f"{name} differs:\n  python {json.dumps(python[name], sort_keys=True)[:600]}\n"
              f"  kiln   {json.dumps(kiln[name], sort_keys=True)[:600]}")
    return 1 if differing else 0


if __name__ == "__main__":
    sys.exit(main())
