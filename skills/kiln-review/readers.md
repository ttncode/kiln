# The review's readers

`kiln practices <id> --stage review` names the readers this change gets and writes their
inputs under `.kiln/tmp/<id>/review/`: `diff.patch` (the whole change against the base,
untracked files included), `claims.md` (what the work says it did: the plan and the
ledger) and `intent.md` (what was asked: the brief and the plan's Goal). Launch every reader
it names, all at once, each as a `general-purpose` subagent with the prompt below and the
placeholders filled: `{dir}` is this skill's directory
(`${CLAUDE_PLUGIN_ROOT}/skills/kiln-review`), `{diff_file}`, `{claims_file}` and
`{intent_file}` are the absolute paths it printed, `{base}` is the work's base commit.

The launch prompts are the sources' own where they have one — BMAD's `customize.toml` for its
lenses, agent-skills' `/ship` Phase A for its personas — and kiln's where they do not.

## reviewer (superpowers, with agent-skills' five axes)

The template in `{dir}/code-reviewer.md`, filled in as that file says.

## blind-hunter (BMAD)

The text of `{dir}/lenses/blind-hunter.md` under its note, with `{diff_file}` filled in.

## edge-case-hunter (BMAD)

```
Read `{dir}/lenses/edge-case-hunter.md` completely and follow it as your review instructions.

claims_file (leave unread until your instructions call for it): {claims_file}

Review content: the unified diff at `{diff_file}`. Read that file — it is the content under review.

Do not invoke any skill, and do not spawn subagents of your own — you are the reviewer. If the instruction file is unreadable, report that exact failure and stop. Return your findings as text in your final message; do not route them through any findings-reporting tool the host may offer.
```

## verification-gap (BMAD)

```
Read `{dir}/lenses/verification-gap.md` completely and follow it as your review instructions.

Review content: the unified diff at `{diff_file}`. Read that file — it is the content under review.

Do not invoke any skill, and do not spawn subagents of your own — you are the reviewer. If the instruction file is unreadable, report that exact failure and stop. Return your findings as text in your final message; do not route them through any findings-reporting tool the host may offer.
```

## intent-alignment (BMAD)

The text of `{dir}/lenses/intent-alignment.md` under its note, with `{verbatim_intent}`
replaced by the contents of `{intent_file}` and `{diff_file}` filled in.

## code-review-specialist, security-auditor, test-engineer (agent-skills' personas)

agent-skills runs these as subagent types whose system prompt is the persona. kiln's readers
are `general-purpose`, so the persona is the first thing each reads:

```
Read `{dir}/personas/<persona>.md` completely (`code-reviewer.md` for code-review-specialist): it is your role for this task, and you follow it as written.

<the persona's line below>

The change is uncommitted in this repository, against base commit {base}: `git diff {base}` and `git status --short` show it, and the same unified diff is at {diff_file}. Do not modify anything, and do not spawn subagents.
```

The persona's line is agent-skills' `/ship` Phase A, verbatim:

- **code-reviewer:** Run a five-axis review (correctness, readability, architecture, security, performance) on the staged changes or recent commits. Output the standard review template.
- **security-auditor:** Run a vulnerability and threat-model pass. Check OWASP Top 10, secrets handling, auth/authz, dependency CVEs. Output the standard audit report.
- **test-engineer:** Analyze test coverage for the change. Identify gaps in happy path, edge cases, error paths, and concurrency scenarios. Output the standard coverage analysis.

## performance (agent-skills' performance skill)

agent-skills has no performance reader in `/ship`; its code-reviewer covers the axis. kiln adds
one when the change carries the performance flag or a pattern that usually costs (a query in a
loop, an unbounded read):

```
Read `{dir}/performance-optimization.md` and `{dir}/performance-checklist.md` completely; if the change renders a web page, read `{dir}/personas/web-performance-auditor.md` too. Then review the change for performance with them.

The change is uncommitted in this repository, against base commit {base}: `git diff {base}` and `git status --short` show it, and the same unified diff is at {diff_file}. Report each finding with its location, what it costs and under what load, and the evidence you checked. Do not modify anything, and do not spawn subagents.
```
