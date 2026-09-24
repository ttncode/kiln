"""Compare kiln's `kiln dna footprint` with tps-project-dna's own context_footprint.py.

Reads kiln's JSON on stdin, runs the source script over the same generated store, and diffs the
two. Two things are left out because the source itself does not define them: which files a
neighbour's `sample` keeps when it shared more than three, and which file a `tier_reason` names
as its example. Both come from Python set iteration, which changes with PYTHONHASHSEED — the
source's output differs between two of its own runs. The tier, the gap and every count are
compared.

Usage: node footprint.mjs <dir> <seed> | python3 compare-footprint.py <dir> <scripts dir>
"""
import json
import re
import subprocess
import sys


EXAMPLE_FILE = re.compile(r"\([^()]*\)| in \S+$")


def comparable(report):
    for entry in report.values():
        for neighbour in entry["neighbors"]["SHARES_FILE"]:
            if neighbour["shared_files"] > 3:
                neighbour.pop("sample")
            neighbour["tier_reason"] = EXAMPLE_FILE.sub("", neighbour["tier_reason"])
    return report


def main() -> int:
    store_dir, source = sys.argv[1], sys.argv[2]
    kiln = json.load(sys.stdin)
    features = list(kiln)
    run = subprocess.run([sys.executable, f"{source}/context_footprint.py", store_dir, *features],
                         capture_output=True, text=True, check=True)
    python = json.loads(run.stdout)
    a = json.dumps(comparable(python), sort_keys=True)
    b = json.dumps(comparable(kiln), sort_keys=True)
    if a != b:
        print(f"differs:\n  python {a[:800]}\n  kiln   {b[:800]}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
