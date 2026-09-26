# Review baseline: today's kiln reviewer against the sources' readers

> Step 0 of the skill-parity plan (`2026-09-26-skill-parity.md`, D185). Nothing in kiln changed.

**What ran.** `node evals/review/run.mjs --arms kiln-rc40,sources --reps 5 --model claude-sonnet-5`,
Claude Code 2.1.283, on the eleven fixtures in `evals/review/fixtures/`. `kiln-rc40` is kiln-review's
reviewer as it stood at rc.40 (superpowers' code-reviewer template, one reader). `sources` is
BMAD-METHOD `5e33d3c`'s four thorough lenses, launched from its `customize.toml`, and agent-skills
`2686b62`'s `/ship` code-reviewer, security-auditor and test-engineer — seven readers. A fresh grader
counts a defect as caught when a report names the same code and the same failure.

Model claude-sonnet-5, 5 run(s) per fixture and arm, 2026-09-26T08:33:54.335Z.

| fixture | defect | kiln-rc40 | sources |
|---|---|---|---|
| 01-unhandled-branch | green-undefined | 5/5 | 5/5 |
| 02-deleted-guard | ownership-check-dropped | 5/5 | 5/5 |
| 03-vacuous-test | config-never-read | 5/5 | 5/5 |
| 03-vacuous-test | vacuous-test | 5/5 | 5/5 |
| 04-wrong-reading | wrong-surface | 5/5 | 5/5 |
| 05-string-sql | sql-injection | 5/5 | 5/5 |
| 06-n-plus-one | n-plus-one | 5/5 | 5/5 |
| 07-secret-in-code | hardcoded-secret | 5/5 | 5/5 |
| 08-unbounded-fetch | unbounded-query | 5/5 | 5/5 |
| 09-user-search | sql-injection | 5/5 | 5/5 |
| 09-user-search | no-auth | 5/5 | 5/5 |
| 09-user-search | route-shadowed | 1/5 | 5/5 |
| 10-ssrf | ssrf | 5/5 | 5/5 |
| 10-ssrf | redirect-follow | 5/5 | 5/5 |
| 11-products-rank | sort-in-loop | 5/5 | 5/5 |
| 11-products-rank | xss | 5/5 | 5/5 |

- **kiln-rc40**: 76/80 caught, $10.08, 0 failed reader run(s)
- **sources**: 80/80 caught, $46.27, 0 failed reader run(s)

**What it says.**

- Both designs catch every planted defect but one, every time. On defects this plain the one
  reader kiln shipped is not worse than the sources' seven — it is 4.6 times cheaper.
- The one difference is the subtlest defect: `/users/search` registered after `/users/:id`, so
  Express never reaches it. The sources caught it in 5 of 5 runs; kiln's reviewer in 1 of 5.
- The fixtures are near a ceiling: fifteen of sixteen defects are caught by both arms every time,
  so they show parity and cannot rank readers finely. Proving that a reader earns its seat — the
  plan's condition for keeping or removing one — needs subtler defects than these. They are what
  the next measurement adds.

The bar for the new REVIEW (step 4) is the sources' column: 80 of 80.

## Step 4: the new REVIEW (D189)

`node evals/review/run.mjs --arms kiln --reps 5 --model claude-sonnet-5`, reading kiln-review as it
lands: the readers `kiln practices --stage review` selects for each fixture's change, launched
with readers.md's prompts. Fixture 11 (one file, twelve lines, nothing sensitive) runs without
agent-skills' three specialists, on `/ship`'s own rule; fixtures 06, 08 and 11 add the performance
reader.

Model claude-sonnet-5, 5 run(s) per fixture and arm, 2026-09-26T09:52:10.563Z.

| fixture | defect | kiln |
|---|---|---|
| 01-unhandled-branch | green-undefined | 5/5 |
| 02-deleted-guard | ownership-check-dropped | 5/5 |
| 03-vacuous-test | config-never-read | 5/5 |
| 03-vacuous-test | vacuous-test | 5/5 |
| 04-wrong-reading | wrong-surface | 5/5 |
| 05-string-sql | sql-injection | 5/5 |
| 06-n-plus-one | n-plus-one | 5/5 |
| 07-secret-in-code | hardcoded-secret | 5/5 |
| 08-unbounded-fetch | unbounded-query | 5/5 |
| 09-user-search | sql-injection | 5/5 |
| 09-user-search | no-auth | 5/5 |
| 09-user-search | route-shadowed | 5/5 |
| 10-ssrf | ssrf | 5/5 |
| 10-ssrf | redirect-follow | 5/5 |
| 11-products-rank | sort-in-loop | 5/5 |
| 11-products-rank | xss | 5/5 |

- **kiln**: 80/80 caught, $55.35, 0 failed reader run(s)

| design | caught | cost |
|---|---|---|
| kiln at rc.40 — one reader | 76 / 80 | $10.08 |
| the sources' seven readers | 80 / 80 | $46.27 |
| **kiln-review now** | **80 / 80** | $55.35 |

The new REVIEW meets the plan's bar: every planted defect at least as often as the sources'
readers, never less often than kiln before. The defect the one-reader review missed four times in
five — the route shadowed by registration order — is caught every time. It costs 5.5 times the
old review and 1.2 times the sources' readers, because it runs superpowers' reviewer beside
theirs and adds a performance reader where the change reads in a loop. With fixtures this near a
ceiling, the measurement cannot yet say which reader is dispensable; that needs subtler probes,
and is Phase B's to answer before any reader is removed.
