"""Compare `kiln dna reconcile` with tps-project-dna's own reconcile_5a.py.

Reads kiln's result JSON on stdin, runs the source over the same manifests and roster with
--out, and diffs the two. kiln's `schema_violations` is left out: the source reports the same
double placements on stderr rather than in its result.

Usage: node reconcile.mjs <dir> <seed> | python3 compare-reconcile.py <dir> <scripts dir>
"""
import glob
import json
import subprocess
import sys


def main() -> int:
    work, source = sys.argv[1], sys.argv[2]
    kiln = json.load(sys.stdin)
    kiln.pop("schema_violations", None)
    manifests = sorted(glob.glob(f"{work}/manifest_*.json"))
    subprocess.run([sys.executable, f"{source}/reconcile_5a.py", *manifests, "--roster",
                    f"{work}/roster.json", "--out", f"{work}/python.json"],
                   capture_output=True, text=True, check=True)
    with open(f"{work}/python.json", encoding="utf-8") as handle:
        python = json.load(handle)
    a, b = json.dumps(python, sort_keys=True), json.dumps(kiln, sort_keys=True)
    if a != b:
        print(f"differs:\n  python {a[:900]}\n  kiln   {b[:900]}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
