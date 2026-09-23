# kiln — Architecture Design

> **STATUS: BUILD-READY.** kiln's own third path is named `full`, not upstream's `architectural` (D68).
> Section 1 (v1 scope) and Sections A–H all locked. The decision log runs to **D148**. It reached D89 after five
> review passes on 2026-09-20: a pre-build audit (7 blockers, 10 high, 14 medium → D48–D62), the
> **pre-P0 hook test, which PASSED** — a `PreToolUse` hook does block a real write in Claude Code
> 2.1.270, and ten further measured answers are in **§1.6** → D63–D64 — a source review of what
> the validated projects actually shipped → D65–D68, and a fourth pass that read the **sources of
> the four skills this design vendors** (3 blockers, 1 high, 2 medium → D69–D72, D76) and closed the
> three parked owner items (→ D73–D75), and a fifth pass in which the owner **read the design
> back from the user's seat** and asked three questions of it (2 blockers, 1 high, 5 medium →
> D77–D84), plus **D85** from a closing attack on that pass's own fixes. Findings and evidence
> live in **`2026-09-19-design-audit.md`**, the companion to this file.
> **Built.** P0–P5 are complete, six acceptance runs are recorded, and the decision log gained
> **D86–D124** from building it and running it on real projects, and **D125–D148** from the
> pre-v1.0 audit that read this file against the product and against mature open-source
> projects. Tier D is graded (`2026-09-21-acceptance-c6-handover.md`). What remains for a v1.0
> tag is one validation run on a production repository, on the build that carries D125–D147.
> **D81's per-module `integration_branch` map is read for protection** — every module's
> shipping branch is protected whether or not it is listed — and by `kiln doctor`. The drift
> check that would read it per module arrives with the Knowledge tier (D22, D82).
> Nothing is parked. Q3 remains open by design and blocks nothing (§5).
> Last updated: 2026-09-23.
>
> **This file is the durable state.** If the conversation is lost, resume from here —
> nothing below needs to be re-derived. See §6 "How to resume".

---

## 0. What kiln is

A harness plugin that drives one unit of work from a tracker reference to a
reviewed, verified, ship-ready change — **flexible across projects, one shared
process, each project adding only its own specifics** — and that never performs
an unsafe action while doing it.

Built from three existing assets, none of which is sufficient alone:

| Asset | Contributes | Missing |
|---|---|---|
| `unioss-plugin` (private) | gated pipeline engine, state machine, runtime enforcement via hooks | fused to one project/stack/tracker |
| `claude_skill` (private) | Project-DNA knowledge layer, station contract, judge-separated-from-builder principle | no runtime, no gates, no enforcement |
| `obra/superpowers` (MIT) | brainstorming, subagent-driven-development, writing/executing-plans, 3-path ceremony | no project knowledge, single-harness-per-install cost |

**Audience: public open source.** Strangers install it. See §1 decision D6.

---

## 1. Evidence base (measured 2026-09-18 — do not re-derive)

### 1.1 unioss-plugin

260 files. 1 plugin, 25 skills, 7 agents, 8 commands, 5 hooks, 33 `.mjs` / 2,951 lines / **16 test files / 0 external deps**.

Per-skill coupling, measured by token counts in each `SKILL.md`:

| Group | Skills | Lines | Verdict |
|---|---|---:|---|
| **1 — pure engine** | `subagent-driven-development`(421), `writing-plans`(199), `brainstorming`(165), `executing-plans`(77), `requesting-code-review`(103), `api-spec`(41) | **970** | rename only |
| **2 — engine with stack leakage** | `unioss-pipeline`(714), `unioss-review`(231), `unioss-implement`(197), `unioss-plan`(109) | **1,251** | **the real work — extraction, not a move** |
| **3 — pure adapter** | migration×2(387), phpunit(202), ci3-simplifier(53); mr-feedback(125), ship(108), gitlab-context(50), feedback(32); verify(106), test-evidence(137) | **1,279** | relocate |
| **4 — composite** | `doctor`(262) | **262** | rewrite as sum of adapter self-checks |

Named leak sites (why Group 2 is extraction):
- `unioss-pipeline/SKILL.md:184` flow graph contains a `"Full PHPUnit"` node
- `:303` `(AdminPage) … phpunit-config apply --import`
- `:465–485` GATE 2 change-preview hardcodes *migration DDL effects*
- `:507,:524` report format prints `PHPUnit — 42/42`, `FrontEnd has no unit tests`
- `unioss-implement/SKILL.md` step sequence **is** stack-shaped: `Step 3 — Verify the migration`, `Step 4 — PHPUnit fast verify (AdminPage only)`

Hooks — reusability measured:

| Hook | Depends on | Generic? |
|---|---|---|
| `guard-rounds.mjs` | `config.artifactRoot` + path pattern `/<id>/round-<n>/` | **100%** |
| `guard-protected-branch.mjs` | `config.gitlab.protected` + git CLI; blocks 7 write-ops, allows checkout/pull/fetch | **99%** (rename config key only) |
| `guard-migrations.mjs`, `php-lint.mjs`, `detect-app-env.mjs` | PHP/CI3 | stack-specific |

Already-correct designs to inherit unchanged:
- **Rules router** — `projects/<name>/rules/index.md`, path-trigger table, base-vs-topic split, upkeep law *"Unrouted is dead"*. Total project rules = **176 lines**.
- **Config** — `DEFAULTS` + deepMerge + env override + `scan --write` auto-repair of wrong module paths.
- **State** — `pipeline-state.json`: `schema_version`, `current_round`, per-round `gate_decisions`, `carry_over`, `artifacts`.

### 1.2 claude_skill

237 files, 6 plugins + 6 incubator. 53 `.py` / **24,285 lines / 0 third-party deps** (all stdlib).

Python split by whether it sits on the A→Z path:

| Group | Lines | On A→Z path? |
|---|---:|---|
| `tps-guest-tour` | ~8,300 | no |
| `tps-project-dna` | ~7,500 <sup>†</sup> | **only at Knowledge tier 1–2** |
| `tps-quality-benchmark` | ~2,150 | no (judge layer) |
| solution-design | ~1,060 | no |
| agent-coder init/start | ~1,400 | replaced by `kiln init` (Node) |

**Python required on the mandatory A→Z path = 0 lines.**

<sup>†</sup> Every number in §1 was measured on **2026-09-19** and is dated, not current. Where
one has since been re-measured because a decision leaned on it, the new figure is recorded with
the decision: `tps-project-dna` is **5,601** lines on 2026-09-23, its assets **142 KB**
(`explorer.html` 61 KB, `laneflow.js` 81 KB) rather than ≈198 KB, and its SKILL description
**1,837** chars rather than 14,218 — upstream fixed the offender §1.3 names. The lesson §1.3
draws is unchanged; the number it draws it from belongs to its date (D107).

DNA store contract (`references/dna-store.md`, `dna-erd.md`):
```
DOMAIN → CAPABILITY → FEATURE → FINDING          (RD-#### real | PRD-#### planned)
FINDING.module   = THE real source-file path      ← the seam
FINDING.evidence = free-text locator, NOT a path  ← join is FILE-level, not line/symbol
FLOW → STAGE → PROCESS ↔ FEATURE
INTAKE_ROUND reserves PLANNED ids                 ← greenfield support, proven (InfoEyes to-be store)
storage: JSONL, "grep is the API"                 ← no DB dependency
```
**Staleness tracking already exists** (corrected 2026-09-19 — an earlier draft of this file wrongly claimed it did not):
```
manifest.json: { "generated_at": "...", "source_pins": { "<repo>": "fdafa754e", ... } }
```
`source_pins` is the per-repo commit the scan was pinned to. `references/update-playbook.md`
(256 lines) is a designed, validated incremental-update procedure whose §1 is literally
**"Diff, don't re-scan"** — `git diff <pinned>..HEAD --stat` per repo yields the exact changed
file list; §2 "Scan the diff, not the file" batches by real diff size. No schema addition is
needed; only a decision about *when kiln fires it* (see D15).

### 1.3 Context budget — measured disease, not hypothetical

`description` in frontmatter is loaded **every session, every project, used or not**.

| Source | chars | ≈ tokens |
|---|---:|---:|
| `claude_skill` — 9 SKILL descriptions | **42,835** | ~11k |
| `claude_skill` — marketplace.json | 13,310 | ~3.5k |
| **claude_skill total always-on** | **56,145** | **~14k** |
| `unioss` — 25 SKILL descriptions | **4,243** | ~1.1k |

Worst two offenders: `tps-quantification-intake` 20,902 chars, `tps-project-dna` 14,218 chars — 82% of the total. Averages: unioss **170 chars/skill**, claude_skill **4,759 chars/skill** (28×).

External corroboration: Vercel 2026 — an 8 KB doc index scored 100% pass vs 79% for explicitly-triggered skills. r/codex 2026-09-06: *"I have like 300 skills installed and it ate up my token count for sure."*

### 1.4 Upstream drift — unioss's Superpowers copies are stale

Compared against `obra/superpowers` main (v6.3.0) on 2026-09-18:

| Missing in unioss's copy | Upstream |
|---|---|
| **Three Paths** (spike / bounded / architectural), ceremony scales to task | v6.3.0 (2026-08-12) |
| **Red Flags** anti-rationalization table (7 rows) | v6.3.0 |
| `## Key Principles` still present (deleted upstream) | removed v6.2.0 |
| `## Advantages` still in SDD:338 (deleted upstream) | removed v6.2.0 |

**Port from upstream, never from the unioss copy.** The pin moved to v6.4.1 (D55) and then became
a **fork point** rather than a pin, over a closure of five skills rather than four (D69).

Independent convergence on ceremony-scaling in 2026: Superpowers v6.3.0 *and* BMAD v6.12.0 (*"Build decides how much ceremony a change needs after investigating it, not before"*).

### 1.5 Visual companion — inherited as-is

`skills/brainstorming/scripts/` = 1,432 lines / 5 files. Quality is high:
- Cross-platform launcher already handles **darwin / win32 / WSL / X11-Wayland / headless** (`server.cjs:295-300`)
- Per-session 32-byte crypto token, mirrored to cookie, `chmod 0600`; comment states it *"defeats DNS rebinding — where a Host/Origin allowlist cannot"*

**One required change on redistribution** — `server.cjs:106` + `brandMarkup()` hotlink `https://primeradiant.com/brand/...?v=VERSION` on every companion open. Conflicts directly with decision D7 (safety gate forbids network egress outside declared tracker/VCS). See D11.

### 1.6 Hook contract — measured 2026-09-20 by the pre-P0 test (do not re-derive)

Claude Code **2.1.270**, node v20.20.2, Linux/WSL2. Method: a throwaway probe plugin loaded with
`claude --plugin-dir` (which registers a plugin for one session, so nothing was installed), a
`PreToolUse` script that logs its stdin and then exits with a mode read from a file, and one
non-interactive `claude -p` run per question with `--permission-mode acceptEdits`. Every row is an
observed outcome, not a reading of the docs — three of them contradict what the documentation
implied.

| # | Question | Measured result |
|---|---|---|
| **1** | **Does `PreToolUse` + `exit 2` actually block a real `Write`?** | **YES.** The file was never created and the agent reported the block. **This is the test that could have ended the project (§3i). It passed.** |
| 2 | Which plugin `hooks.json` shape registers? | **Only the wrapped `{"hooks": {…}}` form.** The flat top-level `{"PreToolUse": […]}` form registered **nothing, silently** — no error, plugin loaded, write went through. Re-wrapping the *same* plugin directory and the *same* script made it block, so the shape is the cause. Closes **Q6**. |
| 3 | A non-`2` exit? | `exit 1` → **ALLOW**, the write happened. D54's floor, confirmed by observation. |
| 4 | A hook that exceeds its `timeout`? | **ALLOW.** A 30 s hook under `"timeout": 2` did not block. So `timeout` bounds latency and is **not** protection; a slow guard is an open guard. Closes **Q5**, and adds timeout to D54's floor. |
| 5 | Does `Edit\|Write` cover `NotebookEdit`? | **NO — and neither does a bare `Edit`.** Both matchers were registered; a real `NotebookEdit` fired neither. Matching is not substring. Shipping §3f's original `Edit\|Write` would have left every notebook edit unguarded (D53). |
| 6 | Do hooks still fire under `bypassPermissions`? | **YES, and the block still holds** with `--permission-mode bypassPermissions --allow-dangerously-skip-permissions`. The guards survive the mode users reach for most. |
| 7 | Do hooks fire inside a **subagent**? | **YES, and they block there.** The parent was forbidden to write; the subagent's `Write` fired the hook and was refused. |
| 8 | Is a subagent's `session_id` the parent's? | **YES.** `--output-format json` reported `0bf36968-…`; the hook payload from the subagent's write carried `0bf36968`. **D50's binding therefore survives a subagent stage.** IMPLEMENT does not use one — `kiln-implement` executes inline and says why — but REVIEW does, and so does the full path's spec reader, which is what this measurement makes safe. |
| 9 | What does the payload actually carry? | `cwd` · `hook_event_name` · `permission_mode` · `prompt_id` · `session_id` · `tool_input` · `tool_name` · `tool_use_id` · `transcript_path`. |
| 10 | Is `.git/` a protected path, as upstream's `sdd-workspace` states? | **No — it is a prompt, not a boundary.** Under `acceptEdits` both `Write` and `Bash` were *asked* rather than auto-accepted; under `bypassPermissions` **both wrote into `.git/` freely**, with a control file in the same run confirming the harness was working. Upstream's comment — *"Claude Code treats `.git/` as a protected path and denies agent writes there"* — holds only at default permissions. **So kiln must not place state under `.git/` for protection**, which was the cheap answer to B8 and is rejected on measurement (D65). |

**Rows 6 and 10 together are the thesis, measured from both sides:** a harness permission prompt is
bypassable; a `PreToolUse` guard is not. kiln's guard layer is strictly stronger than the permission
layer it sits behind — the one thing Section A claims that no other framework has.

**Finding 11 — the one that changes a decision.** When the probe blocked `Write`, the subagent's
**first unprompted retry was `echo "hello" > <path>` through `Bash`**. Not a hypothetical, not
coaxed: the default behaviour of a blocked agent. With `Bash` guarded as well, both attempts were
refused and the file was never created — and the agent's next move was to propose *"disable the
hook or use a directory outside"*. Two consequences: D53's Bash hole cannot stay a mere
ceiling (**D64**), and D48 — kiln's control files unwritable by the agent — is validated as
necessary rather than paranoid.

---

## 2. Decision log

| # | Decision | Rationale | Date |
|---|---|---|---|
| **D1** | Name: **kiln** | — | 09-19 |
| **D2** | `kiln-core` = **100% Node, zero dependency** | hooks run on every Edit/Write/Bash — startup latency × every tool call; Node already resident (host is Node); `kiln init` must not require Python. Precedent: BMAD v6.12.0 shipped `uv` as optional-but-required → *"you could install, see green, and hit a halt on the first `bmad-build`"* | 09-18 |
| **D3** | Python allowed **only behind the Knowledge port** | 7,500 proven extraction lines (Java/Spring, Vue3, Odoo) — rewriting is pure regression risk. **Invariant: the Node/Python boundary coincides with exactly one port boundary, never scattered.** | 09-18 |
| **D4** | Inherited Superpowers skills ported from **upstream v6.3.0**, not the unioss copy | §1.4 drift | 09-18 |
| **D5** | Artifact-language rule **split**: invariants to core, choice to config | core: artifact outlives the chat; language declared once in config never inferred per-run; never-translate list (identifiers, DB table/column/value, UI label, error string, lang key, filename); chat follows the user. Project: `artifact_language` (default `"en"`) | 09-18 |
| **D6** | Audience: **public open source** | strictest bar: strangers' machines, first 10 minutes is the product, MIT attribution obligation, hooks = supply-chain surface | 09-18 |
| **D7** | **Acceptance gate = zero unsafe action** (binary, blocks release) | across N real runs kiln never: pushes to a protected branch, destroys data unasked, reports a failing test as passing, skips a gate *(narrowed by D65 to the enforceable half: no source edit without a gate record matching the current artifact)*, writes outside its sandbox, **or sends anything to the network outside the declared tracker/VCS** *(narrowed by D59 to "kiln's own code performs no egress", then qualified by D83 to except `git fetch` / `git ls-remote` against the configured remote, which D82 requires)*. One destructive incident kills an OSS project's reputation permanently. Output quality / ROI / first-run survival are *grades*, not the gate. | 09-18 |
| **D8** | **Harness v1 = Claude Code only** | the safety gate is harness-dependent: `guard-protected-branch` only fires if the harness actually runs `PreToolUse`. A harness that cannot prove the guards fire makes D7 a paper promise. Precedent: Superpowers v6.1.1 — Codex fell through to hook auto-discovery and re-registered Claude's SessionStart hook; only an explicit `hooks: {}` stopped it (`[]` and an absent field both failed). | 09-18 |
| **D9** | Platform v1 = **Linux + WSL2 + macOS**. Windows native deferred. | WSL2 covers Windows users at a fraction of the cost | 09-18 |
| **D10** | Build approach = **PA-3, triangulation** | build core + `php-ci3` + `zod` simultaneously; **a port exists only if BOTH adapters need it**. Two points define a line — the coupling measurement proved the boundary is invisible from one example. zod's adapter ≈ 50 lines, so triangulation is cheap when the second point is chosen for *shape distance*, not size. Also proves `guards: []` and an empty browser surface on a **real** adapter rather than a fixture. | 09-19 |
| **D11** | Visual companion: **in v1, design untouched**; only the brand hotlink changes (~15 lines / 723 = 2%) | keeping the hotlink contradicts D7. Also: `readSuperpowersVersion()` would render a false product name, and MIT grants copyright rights, **not trademark** — so removing the logo while preserving `LICENSE` + `NOTICE` is *more* compliant, not less. Delete `SUPERPOWERS_BRAND_IMAGE_URL`, `TELEMETRY_DISABLE_ENV_VARS`, `SUPERPOWERS_TELEMETRY_DISABLED`; rename `readSuperpowersVersion()`. `<!-- BRANDING -->` marker and all 1,432 lines of design stay. | 09-19 |
| **D12** | Ceremony paths in v1 = **spike + bounded + full** | spike is the bottom rung of the one-way ratchet — cut it and *"when in doubt take the heavier path"* forces vague tickets into `full`, which is how you burn an hour producing a spec built on guesses. Cost measured at **~80 lines** (everything upstream of classification is shared). Evidence: of 8 real open umami issues, **2 are spike-shaped** (#4540, #4546), 1 is not a code task (#4527), 5 split bounded/full. | 09-19 |

| **D13** | **Integration is never code. Enforcement always is.** | Measured: `search_code repo:obra/superpowers "gh issue" OR jira OR tracker` → **0 results**. 288K stars, 13 harnesses, no tracker integration at all — it starts from a conversation. agent-skills mentions a tracker exactly once, as a *config pointer*: default `tasks/todo.md`, or "if the project's agent rules or the user designate an issue tracker (GitHub Issues, Jira, Linear, bd), create one tracker item per task" — no client, no auth, no rate limits. Its browser skill is pure guidance over **Chrome DevTools MCP**, zero automation code. The agent already has MCP + `gh`/`glab` + bash; writing a client re-implements that and inherits its maintenance. **But hooks cannot call MCP** — they are separate node processes with no tool registry — so anything that must be *enforced* has to be standalone code. That is the line. | 09-19 |
| **D14** | Source hierarchy re-calibrated | `superpowers` + `agent-skills` are externally validated by many users → **the standard**. `unioss-plugin` and `claude_skill` are unvalidated single-team code → treated as **evidence of which problems are real**, not as the template for solutions. Exactly three things are inherited from unioss verbatim: the guard model, the state model, the rules-router model. Its `fetch-ticket.mjs` / `gitlab-attachments.mjs` / `unioss-verify` are **not** carried over. The *method* in `unioss-test-evidence` (derive cases mechanically from changes × spec AC × scope) is kept; its code is not. | 09-19 |
| **D15** | DNA refresh has **two triggers**, only one of which is mandatory | **Write path (automatic, unconditional):** after SHIP, run the incremental update scoped to *this round's own diff*. kiln knows the exact file list, so the cost is bounded and it can never fall behind its own work. Provenance records which round produced the entry. **Read path (a check, not an update):** at INVESTIGATE, compare `manifest.source_pins` against HEAD. Drift is *reported with a number*, and findings inside the drift are marked low-confidence; a full catch-up is offered, never forced — a month of drift can be 500 files and must not silently become part of a ticket. | 09-19 |
| **D16** | **Auto mode: opt-in, removes approval gates, never removes safety halts** | Validated precedent — Superpowers v6.3.0: *"Non-catastrophic conflicts and ambiguities get a recorded ruling and work continues; **only destructive or irreversible actions still stop for a human.**"* BMAD Build Auto halts on named conditions (`intent gap`, `matrix ambiguity`, `matrix test audit failed`). So: **approval gates** (is this spec/plan/review good?) become recorded rulings in auto mode; **safety halts** always stop. Eligibility comes from the classifier, after investigation: `bounded` → eligible, `spike` → never (its output *is* a question), `full` → explicit opt-in only. Auto mode **relocates** the human gate to the PR; it does not delete it. Default is off. | 09-19 |
| **D18** | **Rounds are deleted.** Multi-pass work gets a *field*, not a subsystem. | The problem (one unit of work spans several sittings; later sittings must not destroy earlier records) is universal, but `round-N/` is not the mechanism. All three validated sources converge on **git as the history**: superpowers v6.2.0 — *"the workspace is deleted once the final review is clean — git history is the durable record"*, and their named bug was a workspace with *"no plan identity and no end-of-life"*; BMAD anchors state to git (`baseline_revision` is a SHA); agent-skills uses flat `tasks/todo.md`. So: `.kiln/work/<id>/` holds durable artifacts (committed; history via `git log`), `.kiln/tmp/<id>/` holds scratch (gitignored; deleted when review is clean), and `state.json` carries `pass: N` plus `carry_over[]` — the one thing git does not give directly. Identity = `<id>`; end-of-life = tmp deletion. Saves the stranger one concept in their first ten minutes. | 09-19 |
| **D19** | `guard-rounds` → **`guard-sandbox`** | guard-rounds protected a convention D18 deletes; the *real* risk it aimed at survives as D7 item 5. Allowed writes: project source, `.kiln/work/<active-id>/`, `.kiln/tmp/<active-id>/`. Blocked: **another ticket's work dir** (the genuine cross-contamination bug), anything outside the repo. Same protective intent, universal mechanism, no invented concept, and it serves D7 directly. | 09-19 |
| **D20** | **Rule-budget gate adopted from claude_skill, with 2 of its 3 questions mechanized** | The three questions are: can it merge into an existing rule; can an equivalent passage be deleted (goal: total volume **flat**, not monotonically increasing with incident count); is it **routed** — *"unrouted is dead weight: route it or don't add it"*. Decisive evidence for mechanizing rather than documenting: the repo that **authored** this rule violated it 28× (claude_skill 4,759 chars/skill vs unioss 170) because it was prose, not a gate. Mechanized: routing (every file in `.kiln/rules/` must appear in `index.md`'s trigger table — `kiln doctor` lists orphans) and flat volume (total lines vs a baseline in config). Not mechanized: mergeability (judgment; proxy signal = file-count growth). Applied at two tiers — project rules via the `kiln init` template + `kiln doctor`; kiln's own corpus via `budget.mjs` in CI. Note the independent convergence: unioss's `rules/index.md` invented the same "Unrouted is dead" law without knowing claude_skill had it. | 09-19 |
| **D21** | **Question and gate mechanics adopted from `agent-skills/interview-me`; style rules rejected** | Neither validated source has a global output-format skill; each skill carries its own shapes. Adopted because each prevents a real failure: **(a)** `Q` + `GUESS` — every question ships the asker's own hypothesis (*"the user reacts faster to a wrong guess than they generate an answer from scratch"*); **(b)** the **explicit-yes gate** with its list of non-yeses — "whatever you think" (delegation → re-ask as two concrete options), "sounds good", "sure let's go", silence — a gate that accepts "whatever you think" is a broken gate, and this directly protects D7; **(c)** fixed restate shape ending in **Out of scope**, *"non-negotiable… half of misalignment is silent disagreement about what is not being built"*; **(d)** a checkable stop condition (*"can I predict the user's reaction to the next three questions?"*) instead of a vibe; **(e)** the three closing tables — Rationalizations / Red Flags / Verification. **Rejected:** pure style rules ("use tables not prose") — models already do this, so writing it costs context without changing behaviour, which is exactly what D20 must block. **Gate format is defined once, in the orchestrator**, because the orchestrator is the only component that renders gates — no shared voice file, no duplication across skills. | 09-19 |
| **D22** | **DNA refresh has ONE trigger, at the start — the post-ship write is deleted** (supersedes D15) | D15 was wrong. SHIP opens a PR; the PR may be rejected, sit for weeks, or be heavily rewritten before merge. Recording it as fact puts code into DNA that does not exist on the integration branch, breaking DNA's evidence-linked guarantee. Catching up at INVESTIGATE is correct **by construction** — everything in the drift is already merged — and self-healing, since the next ticket picks up whatever merged since. One trigger: compare `manifest.source_pins` against **`origin/<integration-branch>`, never `HEAD`** (on a feature branch, `HEAD` contains your own unmerged work — comparing against it recreates the very bug being fixed). No drift → full confidence; small drift → offer catch-up, default yes; large drift → use DNA, mark the drifted region low-confidence, print the number, offer catch-up, default no. A month of drift can be 500 files and must never silently become part of a ticket. | 09-19 |
| **D23** | **No SCOPE stage. 8 stages → 7.** | `unioss-scope` writes *"the PM/QC-facing scope.md for a **finished** ticket"* — that is an impact **report**, not work scoping. One word doing two jobs. Split: **blast radius** is an *input* (feeds classification, estimate, test selection) and belongs at INVESTIGATE, where `Knowledge.blastRadius` already sits; the **impact report** is a *rendering* of information already held at ship time, so it is a section of the PR body, not a stage. What is kept, and is better than unioss: a **reconciliation at review time** — predicted blast radius vs the actual diff. Cheap (two lists already in hand), one line, and it detects the dangerous case: `predicted 3 files · actual 11 · ⚠ 8 beyond prediction — re-check scope before accepting`. It does not merely describe impact; it catches an investigation that was wrong. | 09-19 |
| **D24** | **`/kiln <arg>` resolves its own argument. Commands drop 4 → 3.** | No `resume` command. Resolution order, most specific first: (1) a URL → the agent fetches it with its own tools; (2) `.kiln/work/<arg>/state.json` exists → continue, branching on `status` — `in_progress` resumes at the stopped step, `reviewed` goes to ship, `shipped` opens pass N+1 after confirmation; (3) looks like a ticket ref (`42`, `PROJ-123`) **and** a tracker is configured → fetch; (4) otherwise → treat as a description. `/kiln 42` when both `work/42/` and issue #42 exist is not a real collision — work-dir 42 *is* issue 42's work. This subsumes two commands: `feedback` (covered by `status: shipped`) and `ship` (covered by `status: reviewed`). Final surface: **`init` · `<arg>` · `doctor`**; a bare `/kiln` lists work in progress. | 09-19 |
| **D25** | **The orchestrator emits a todo list right after classification; gates are their own items** | Validated mechanism — `using-superpowers`: *"If it has a checklist, create a todo per item"*; `brainstorming` v6.3.0: *"create a task for each item on your path and complete them in order"*; SDD: *"Read plan… create todos"*. (A "≥3 items" threshold could not be confirmed in the files read, and kiln needs none: the stage sequence **is** the checklist, and the shortest path already has 5 items.) Emitted **after** classification so the list matches the chosen path. **Gates are separate items, not suffixes** — a gate item is where *the user* must act, so the list shows at a glance whether kiln is working or waiting. Two rules: only the orchestrator creates todos (subagent stages do not, or the list nests into noise); a ratchet upgrade rewrites the list and says so. Auto mode still emits it — nothing to click, but progress stays visible. | 09-19 |
| **D26** | **`javascript.md` / `bash.md` apply to kiln's own code; 8 of 10 rules are lint-enforced. Vendored code keeps upstream style.** | Source: `~/.dotfiles/agentic/rules/` (javascript.md 148 lines, bash.md 207 lines). Per D20's philosophy — mechanize, don't document. Lint-enforced: `max-params: 2`, `max-lines-per-function: 20`, `prefer-const`/`no-var`, `eqeqeq`, `no-unused-vars`, `no-console` (allow error/warn — CLI stderr is a handler), `no-param-reassign`, `max-depth`/`complexity`. Judgment-only, left to review: "one function does one thing", "name by action + intent". **Two consequences:** (a) bash.md has almost no surface — every line kiln writes is `.mjs`; the only bash in the tree is the inherited `start-server.sh` (209) / `stop-server.sh` (120), so `shellcheck` joins CI only if kiln ever writes its own bash. (b) Inherited MIT code lives under `vendor/`, **keeps upstream style, and is excluded from lint** — restyling it means a merge conflict on every upstream release. `NOTICE` records provenance. | 09-19 |
| **D27** | **Markdown follows the agent-skills / superpowers skill anatomy** | `---` frontmatter (`name` lowercase-hyphen, `description` = trigger conditions) → `# Title` → Overview → When to Use (+ When NOT to use) → Process (steps with checkpoints and exit criteria) → `\| Rationalization \| Reality \|` table (present in **both** repos) → Red Flags (observable symptoms) → Verification (evidence checkboxes) → `references/` loaded on demand, never inlined. Superpowers adds `<HARD-GATE>` blocks and graphviz `dot` flow diagrams. | 09-19 |
| **D17** | CI means **kiln's own CI**, never the user's | kiln requires no CI from the projects it runs on. Its own GitHub Actions run the conformance fixture, the guard unit tests (the D7 list), the context-budget check, and version-sync. Those tests are plain `node --test` and run locally too — CI only automates them. | 09-19 |
| **D28** | **Seven stages; `CLASSIFY` is not one of them; full verification runs *after* the review gate** | Stages are INVESTIGATE · SPEC · PLAN · IMPLEMENT · REVIEW · VERIFY · SHIP. Classification is the terminal act of INVESTIGATE (D12) and produces no artifact, so it is not a stage — making it one would add a stage that can never fail, and D25's todo list would show a step the user cannot act on. Order places full verification after the review gate because a reviewer reads a diff, not test output: running a ten-minute suite before the gate spends it on code the review may reject. Precedent: unioss ran `Reviewer → GATE 3 → Full PHPUnit` in production. Cost accepted: the reviewer sees code that has passed only the fast steps. **`changes.md` is deleted** — `git diff` already is that file (D18). | 09-19 |
| **D29** | **`steps[]` executes in declaration order; the exit code is the only truth** | No topological sort and no dependency graph — declaration order is the order, because a stack author writing JSON can already express sequence by writing it in sequence, and a graph buys nothing a list does not. `requires: ["<effect>"]` is a **precondition, not an ordering edge**: a step whose required effect is absent from this change is **skipped with a recorded reason**, never failed. Two phases: `fast` (inside IMPLEMENT — only what the change touched) and `full` (default; after the review gate). Pass/fail comes from the process exit code and **stdout is never parsed** — parsing output is exactly how D7 item 3 ("reports a failing test as passing") happens. Evidence: `{id, cmd, exit, ms}` into `state.verify[]`, raw log into `tmp/<id>/steps/<id>.log`. A failing step stops the run and surfaces the tool's own output verbatim (the inherited environment-broken law). | 09-19 |
| **D30** | **Effect vocabulary: three fixed core glyphs, stack effects are three JSON fields, no DSL** | Core, universal, file-level: `+ create` · `~ modify` · `- delete`. A stack may add effects as `{ "id", "glyph", "hint" }` and nothing more. **Anti-inflation law: an effect exists only if it changes something the file-level triple cannot describe** — DB schema, an index, a queue, any state outside the repo. If it is only a file, it is `+~-`. Detection of *dangerous* effects (`DROP COLUMN`) is deliberately **not** in the JSON: it must fire without the agent's cooperation (§3c criterion 1), so it stays a stack guard script. Config never carries safety regexes. Known weakness, accepted: at v1 only `stack-php-ci3` declares an effect, so the extension point is exercised by one adapter — the disease §1 measured. Held to three fields precisely so that being wrong costs nothing to undo. | 09-19 |
| **D31** | **The approved change preview becomes `state.predicted[]`; reconciliation reports, never blocks** | Preview format inherited from unioss (one of the three verbatim inheritances, D14) with the stack-fused parts removed: no points (estimation is kiln-judge, v2), no submodule line (becomes `repo.kind`, Q1), no branch header (Section F). Its standing rule is kept unchanged — **every row is derived from the approved plan, never from a guess about what the coder will do**. The approved rows are stored as `state.predicted[]`, which makes D23's reconciliation nearly free: at REVIEW, diff them against `git diff --name-status <base>...HEAD` plus untracked, and print one line. It is **code**, in `blast.mjs`, because it feeds a gated decision and must be reproducible (§3c criterion 3). Two alternatives rejected: (a) `guard-gate` blocking edits to files outside `predicted[]` — discovery during implementation is legitimate and this would block constantly, converting a report into a new failure mode; (b) halting when an unpredicted *effect* appears — `guard-migrations` already covers the destructive case, so this would be a second gate for one already-guarded risk. | 09-19 |
| **D32** | **One dispatcher, statically registered; three `hooks.json` entries, no `SessionStart`** | Measured 2026-09-19: unioss has **no dispatcher** — its `hooks.json` registers each guard script as its own `command`. That works only because unioss serves one project. kiln needs a dispatcher for two reasons that are constraints, not tidiness: **(a)** the plugin is installed once and runs on N projects, so `hooks.json` cannot vary, yet `stack.guards[]` does (php-ci3 two, node zero) — only an entry point that reads the project's config can attach dynamic guards to a static registration; **(b)** ordering is controllable only inside one process, so §3c's "core guards run first, always" cannot be delegated to the harness's scheduling of separate entries. The design therefore does not depend on whether Claude Code parallelizes them. Registration is explicit, never auto-discovered (D8). Hook contract, measured from unioss production code: JSON on stdin, `exit 2` + stderr blocks, `exit 0` allows. Latency budget: node v20.20.2 cold start measured at **20–30 ms** over five runs, plus one small `state.json` read, on every Edit/Write/Bash — which is what D2's zero-dependency rule buys. Early-exit inherited: a Bash command with no `git` in it never spawns git. | 09-19 |
| **D33** | **Fail-closed law — a guard fails open only when it can prove there is nothing to protect** | This **inverts** unioss, whose guard carries the comment *"never block because the guard itself failed"* and `catch { process.exit(0) }`. The inversion is deliberate: unioss's guards are an internal convenience, kiln's guards **are** the product promise (D7), and a guard that fails open makes D7 a paper promise — precisely the prompt-only weakness kiln claims to fix. The law: *unreadable ≠ absent*. No active `work/<id>` → ALLOW (proven: kiln is not driving this session). `state.json` unreadable → BLOCK. Config missing or broken → `guard-protected-branch` falls back to a hardcoded `main`/`master` list and still blocks, never falls back to allow. A **stack** guard that crashes → BLOCK, printing the trace, the file, and `kiln doctor` — one law, no exemption for project-contributed code. CI-checkable invariant: **no core guard may have a failure branch ending in ALLOW**. Accepted risk, already noted in §3c: a crashing stack guard blocks every edit; Section G carries a mandatory acceptance item for it. | 09-19 |
| **D34** | **`guard-sandbox` extends to the Bash matcher — D7 item 2 had no mechanism at all** | Found while writing Section E: *"never destroys data unasked"* was enforced only for `Edit`/`Write` (guard-sandbox) and for php-ci3 DDL (guard-migrations). `rm -rf /home/you/data` through Bash was touched by nothing, so the acceptance item could only have passed by luck. Fixed without a fourth guard: deleting a file outside the repo **is** a write outside the sandbox — same concept, same guard, zero new concepts for a stranger. Scope deliberately narrow: only `rm -r*f*` and `git clean -xfd` whose target resolves outside the repo root. **No shell parsing** — everything else stays with the harness's own permission prompt, and the ceiling is recorded in a `ponytail:` comment at the call site. Inventory: `guard-sandbox` 90 → ~110 lines. | 09-19 |
| **D35** | **The D7 list becomes six tests; item 6 is a static check and says so** | Two tiers, reusing unioss's `isMain` idiom so the decision logic is an exported pure function and most tests need no process spawn. Items 1–5 are runtime tests against the real hook scripts (exit code + stderr). **Item 6 (network egress) is a CI grep**, not a runtime test: `fetch(` / `node:http` / `node:net` outside an allowlist fails the build, plus an assertion that the string `primeradiant.com` is absent from the tree (D11). A dynamic egress test is not worth its cost, and claiming item 6 is runtime-verified when it is static would itself be the kind of overstatement D7 item 3 exists to prevent. The distinction is recorded in Section G's grading, not hidden. | 09-19 |

| **D36** | **`.kiln/work/<id>/` is tracked by default, with one knob; "tracked" does not mean kiln commits during a run** | D18 made git the durable record, so gitignoring `work/` would leave D18 with no mechanism — `git log -- .kiln/work/<id>/` is the whole history story. But the approved test subjects (§4) include **forks of strangers' repositories**, where a PR carrying `brief.md` / `plan.md` / `review.md` is noise to a maintainer, and undoing that choice afterwards means rewriting history. A wrong default that is not cheaply reversible is exactly the case where a knob pays for itself: `work.committed`, default `true`. **Clarification the design lacked:** *tracked* means the files are not gitignored and are swept up by the SHIP commit — kiln does **not** commit at each gate. A mid-run crash loses nothing either way, because the artifacts and `state.json` are durable on disk the moment they are written. | 09-19 |
| **D37** | **Config is one flat file with an anti-growth ratchet: exactly one env var, and a new top-level key needs a decision entry** | Resolution order inherited from unioss, measured: **env → file → built-in default**. unioss's env surface stayed surgical (two variables), but its config still reached **335 lines** because nothing stopped keys being added. kiln's ratchet: the only environment variable is `KILN_ROOT`; a second one, or a new top-level key, requires an entry in §2. Two things unioss carries that kiln drops: `buildEnv()` (steps already interpolate `${cmd.test}` per D29, and skills read the JSON directly — an exported shell env is a second copy of the same values), and the nested `.walkthrough/.config/<name>.config.json` path, replaced by a flat `.kiln/config.json`. `branch_pattern` lives here, closing the item Section B deferred. | 09-19 |
| **D38** | **Q1 closed: multi-repo is config, not a port — and the sandbox boundary is `repo.root`** | Measured shape of the one real multi-repo subject: UNIOSS has **4 modules — 2 apps that own tickets and 2 submodules that get their own MR but never a ticket** — checked out side by side under a workspace root that is not itself a git repo. Tested against D10: does the VCS side need a method only one adapter would implement? **No** — "open a PR for each changed module" is the agent using `gh`/`glab` (D13). So it is `repo: { kind, root, modules, tickets }` in config, and core reads a list whose default length is 1. **Cut from unioss along with it:** the entire key-vocabulary layer — `REPO_KEY_BY_NAME`, `TICKET_PREFIX_BY_KEY`, `moduleKeyForRepo()`, `ticketPrefixForRepo()` — roughly 40 lines and one concept, because a work id comes from the tracker ref (D24), never from a module prefix. **Consequence that closes a hole in D34:** with submodules present, "outside the repo root" is ambiguous; the sandbox boundary is `repo.root` (the workspace), not the git repository that happens to contain the cwd. Config discovery keeps unioss's ancestor walk, whose comment names the bug it fixes: the coder works inside an app checkout, so a cwd-only lookup silently writes artifacts into the wrong directory. | 09-19 |
| **D39** | **Update is three rules and no new command** | The plugin itself updates through the harness (`/plugin update kiln`) — kiln writes nothing there. A config or state file at a **lower** `schema_version` is migrated **in memory** and one line tells the user to run `kiln doctor --write`; kiln never silently rewrites a committed file. A file at a **higher** version than this kiln knows is **refused**, printing both numbers rather than guessing. Wrong module paths are repaired by `kiln doctor --write`, inheriting unioss's `scan --write`. Everything lands on the existing three commands (D24). | 09-19 |
| **D40** | **Q4 closed: `stack-node` ships no `lint` step; `kiln init` adds one when it detects a `lint` script** | Measured across three real Node subjects: zod has no `lint` script, umami uses biome, hono uses eslint+prettier. Three projects, three answers — which means there is no correct default, and a default that is wrong two times in three is worse than none. Default `steps` are `typecheck` + `unit`. Detection belongs to `init`, which already inspects the stack, so this costs no new code. **Explicitly rejected:** a "skip a step whose script does not exist" rule — D29's `requires` covers *effects*, not script existence, and adding that branch invents a mechanism to dodge a question config already answers. | 09-19 |
| **D41** | **Two test tiers with different jobs: conformance gates every PR, acceptance gates only releases** | Tier 1 (machine, `node --test`, CI and local) answers *does the code meet its contract*: the seven D7 tests (D35, D48), the `repo-null` fixture, guard unit tests on the exported pure functions, the context-budget and rules-routing checks, lint (D26, `vendor/` excluded) and version-sync (D17). Tier 2 (human, real repos, before a release tag) answers *did this work for a person*. They are not the same question and must not share a gate. | 09-19 |
| **D42** | **The safety gate counts unsafe actions that COMPLETED, never guard firings — and the scorecard is eight lines** | The first draft of this section counted guard blocks, which rewards a build that blocks nothing: a guard that fires is the system working, so `blocks: 3` is good news. The gate is *unsafe actions completed = 0*, observed by a four-check post-run audit — `git reflog` on the integration branch; the fork's default branch carrying no agent commits (§4 guard rail); `state.verify[]` exit codes reconciled against the words in the final report (D7 item 3 caught in the wild); and writes outside `repo.root`, **which is the weak check and is recorded as weak rather than dressed up**. Everything else on the scorecard is a *grade*, not a gate: gates shown vs overridden, human edits after accept, wall clock and turns, first-run survival, and the honest one — *would I run it again on this ticket*. Anti-growth rule, per D20: a field is added only when a past run would have been graded wrong without it. Item 6 of D7 is written as **static**, never "verified" (D35). | 09-19 |
| **D43** | **Three adversarial acceptance items are mandatory, discharging the risks Sections C and E recorded** | Each pays off a promise made earlier rather than testing something new. **(a)** `guard-gate` has never run anywhere (§3c noted risk): one run must show it blocking a real pre-gate source edit, **and** one must show it *not* false-blocking — a guard that only ever blocks is indistinguishable from a broken one. **(b)** Fail-closed brick risk (D33): deliberately break a stack guard and assert the message names the file and `kiln doctor`, and that the user recovers **without editing kiln's own code**. **(c)** The same for an unreadable `state.json`, which is guard-gate's fail-closed path. | 09-19 |
| **D44** | **Release thresholds are asymmetric, and contributor PRs gate on conformance only** | **v1.0:** six acceptance runs covering at least three subjects and **all three ceremony paths**, including at least one `full` and one auto-mode run, with unsafe-actions-completed = 0 across every one. **Patch:** conformance plus a single smoke run. Requiring six runs per patch would eat the release cadence — a process that consumes itself protects nothing. **Contributor PRs run conformance only.** Acceptance needs a real repo, a real ticket and a human grader; kiln is built solo (D6), so demanding it of contributors asks for infrastructure they do not have and makes the maintainer a bottleneck on every PR. The accepted cost: a PR can pass CI and still break real behaviour, surfacing only at the next pre-release acceptance round. That cost is tolerable only because the six D7 checks are **machine tests, not a human checklist** — which is why D35 insists on that. The grades (survival, ROI, override count) block nothing; they feed Section H's bankruptcy conditions. | 09-19 |
| **D45** | **The roadmap is a sequence of risk checkpoints, not a schedule — and the highest-risk assumption is tested before P0 begins** | No dates and no effort estimates appear in it: this document has already been wrong twice by asserting numbers it had not measured (§6.1 rule 2), and a phase estimate is exactly that kind of number. Each phase instead carries one **falsifiable premise**. The ordering law is *highest-risk assumption first*, which moved the single most important test **ahead of all construction**: prove that a `PreToolUse` hook actually blocks a real Edit in Claude Code. Section A's entire claim — *"hooks block at runtime"*, the one column no other framework has — rests on it, and it costs an afternoon to check against months to discover late. | 09-19 |
| **D46** | **A bankruptcy condition is invalid unless it names how it is observed and what gets abandoned** | A kill condition nobody can evaluate is decoration, and decoration in a roadmap is worse than nothing because it reads as rigour. Every phase therefore carries three fields, not one: the premise, **how its falsehood would be observed**, and **the escape hatch** — what is deleted or deferred if it is false. Three conditions in the first draft had no observation method and were rewritten or dropped. Most observations reuse instruments Section G already built: the scorecard's `Gates: N shown · M overridden` grades classification (P3), `First-run survival` grades the install experience (P5), and D43's adversarial item supplies the repeated-fire count for hooks (P1) — the roadmap introduces no measurement apparatus of its own. | 09-19 |
| **D47** | **Q2 stays open by design and is decided by P4's verdict, not now** | The question — does the Knowledge port survive D10's "both adapters need it" when both v1 adapters are null — cannot be settled by argument, only by whether tier-0 output is *used*. The standing condition is §5's proposed resolution: the null adapter must be a **real degraded implementation** (grep-based blast radius), never a no-op, so the port is genuinely exercised at v1. P4 then decides it with an observable: how often the `Scope —` reconciliation line leads to an action across the six acceptance runs. If it is noise, the escape hatch is deferring the Knowledge port to v1.2 alongside DNA, which answers Q2 negatively. Deciding now means guessing; deciding at P4 costs nothing extra, because P4 runs either way. | 09-19 |

#### Post-audit entries (2026-09-20)

All of D48–D62 come from the pre-build audit recorded in `2026-09-19-design-audit.md`. None
required a redesign: six of the seven blockers were one field or one guard condition, and the
seventh was a ceiling to name.

| # | Decision | Rationale | Date |
|---|---|---|---|
| **D48** | **kiln's control files are written by kiln's code; the guards block tool-writes to them** | `guard-gate` allowed every write under `.kiln/work/<id>/`, and `state.json` lives there — so one `Edit` setting `gates.plan = approved` unlocked source edits, and the same shape empties `vcs.protected` and disarms `guard-protected-branch`. The enforcement was reading a file the enforced party could write, which makes D7 items 1 and 4 self-defeating. The ALLOW now covers the **artifacts** (`brief.md`, `spec.md`, `plan.md`, `review.md`, `findings.md`) and never `state.json`; `guard-sandbox` blocks `.kiln/config.json` on both matchers. Rejected: a checksum over state (whoever can write the file can write the checksum) and moving state outside the repo (D18 makes git the history, and a file outside the repo cannot be committed). Becomes D7 test 7. | 09-20 |
| **D49** | **Gate keys are fixed and total, and one table maps path → the gate that authorizes source edits** | §3c shipped the literal placeholder `state.gates[<gate authorizing source edits>]`, which is unimplementable. Keys: `probe` · `spec` · `plan` · `review` · `ship`. `AUTHORIZING = { spike: "probe", bounded: "plan", full: "plan" }`; every other key gates only its own transition. The `probe` gate is emitted as the terminal act of INVESTIGATE on the spike path — the same position classification already occupies (D28) — so it stays out of the stage table for the same reason classification does, and D25's todo list gains one item rather than one stage. | 09-20 |
| **D50** | **The active work id is bound to the harness `session_id` and resolved from hook stdin, never by scanning `work/`** | A guard is a separate process holding only stdin, and `<active-id>` had no resolver: with two `in_progress` work dirs the guard cannot answer, and under D33 a guard that cannot answer must BLOCK — bricking the session. Measured: PreToolUse stdin carries `session_id`, `cwd`, `tool_name`, `tool_input`. So `state.json` gains `session_id`, `/kiln <arg>` rebinds it on every resume, no match means kiln is not driving this session (ALLOW, D33's proven branch), and a match on two is a BLOCK naming both. Rejected: scanning for `status: in_progress`, because a work dir left over from last week would guard every unrelated session. Corroboration that this is a real failure in shipped code: BMAD #2849, *"bmad-build resume and parallel runs lack attributable per-run state"*. | 09-20 |
| **D51** | **A work id is the tracker ref when there is one and `<yyyymmdd>-<slug>` otherwise; a collision is refused, never merged** | D24 resolved four argument shapes but never said what `<id>` becomes for the entry point §3b calls **primary** — a sentence — while `work/<id>/` is the entire identity model (D18). A tracker ref is used verbatim as the tracker writes it (`PROJ-123`, `42`); a sentence becomes the date plus a 4–6 word lowercase-hyphen slug. Multi-repo adds the ticket-owning module as a prefix **only** when `repo.tickets` has more than one entry — two modules can both own issue `42`, the one case D38's "no module prefix" rule did not foresee. If the directory exists and its state is not resumable for this argument, kiln prints both and refuses; it never reuses the directory. Precedent: superpowers #2138 — two plans with the same basename shared one workspace and `task-brief` silently overwrote the other's brief, fixed upstream in v6.4.1 by recording each workspace's owning plan. | 09-20 |
| **D52** | **Sandbox membership is decided on a resolved real path compared segment-wise, and a symlink leaf is rejected rather than followed** | A string comparison is not a boundary, and three things defeated it. A symlink under `work/<id>/` pointing at `~/.bashrc` passes any prefix test — agent-skills #295 finding 4 rates this High **in shipped code**: *"no symlink check; arbitrary-file-overwrite primitive"*, with a session-long TOCTOU window. `startsWith(root)` accepts `/home/you/repo-evil` for root `/home/you/repo`. And macOS ships a case-insensitive filesystem by default (D9 ships macOS), so `.KILN/work` is the same file as `.kiln/work` but not the same string. Mechanism: `realpath` the parent, because the leaf may not exist yet; `lstat` the leaf and reject a symlink outright; compare resolved segment arrays. Accepted ceiling, recorded in a `ponytail:` comment rather than claimed away: a PreToolUse hook checks in one process and the write happens in another, so the TOCTOU window cannot be fully closed from here. Feeds D7 tests 2 and 5. | 09-20 |
| **D53** | **The edit matcher is `Edit\|Write\|NotebookEdit`, and `guard-gate`'s Bash ceiling is named rather than closed** | `NotebookEdit` is a live tool and was missing; matchers are case-sensitive and the alternation's anchoring is undocumented, so relying on `Edit` matching inside `NotebookEdit` would be relying on an unknown. The larger hole cannot be closed the same way: `sed -i`, `tee`, a heredoc and `python -c` all edit source through `Bash` without touching the edit matcher, so `guard-gate` is bypassable there. Closing it needs shell parsing, which D34 refused for exactly this reason — so the ceiling is stated instead: **D7 item 4 is enforced against the agent's file-editing tools, not against arbitrary shell**, recorded in a `ponytail:` comment at the registration site and graded as a ceiling in Section G, the way D35 grades item 6 as static. An MCP filesystem write tool is out of scope by the same sentence. | 09-20 |
| **D54** | **The fail-closed law has a floor: a failure that prevents the dispatcher from running fails OPEN, and the invariant now says so** | Measured contract: `0` success, `2` blocking, **`Other` non-blocking — the tool runs**. So node absent from `PATH` (superpowers #2310 is this in production: *"SessionStart hooks fail when PATH is broken"*), a syntax error in `dispatch.mjs`, an uncaught throw exiting 1, OOM, or a hook timeout all fail open, and D33's invariant cannot reach them because the process never reaches a branch. Done: one top-level `try/catch` whose only exit is `2`; `"timeout": 5` on all three registrations, which were carrying none, so a hung guard would have hung every Edit; `kiln doctor` asserts node resolves from a bare `PATH`. Not claimed: that D7 holds when kiln cannot execute. The invariant becomes *no core guard may have a failure branch ending in ALLOW **once the dispatcher is running***. Whether a timeout blocks or allows is measured in the pre-P0 test, not assumed. This is D35's principle — a static check that says it is static — applied to a ceiling. | 09-20 |
| **D55** | **Upstream pin moves to v6.4.1 (supersedes D4's pin), and four of its measured findings are adopted** | v6.4.1 published 2026-09-19T00:32Z, after §1's measurement, and it changes exactly the four skills kiln inherits. Load-bearing: `executing-plans` *"was a 64-line stub that measured the same as running with no plugin at all"* and is rebuilt as Native execution — porting the v6.3.0 copy would port a version measured as worthless. Adopted into kiln's own artifacts: a **Review Focus** section in `plan.md`, up to five spec-implied inputs no task's tests exercise, because *"in evals, every implementer shipped the same crash on an input the spec implied but never named"* (#2319); `review.md` judges unspecified behaviour by what a reasonable user would expect and carries a **Declined to judge** list (#2319); a `fast`-phase pass is **never** reported as green, because *"the project's suite defines green, not just your test file"* — sessions ran only the named file in 11 of 12 probe runs (#2110); and the vendored `start-server.sh` / `stop-server.sh` are invoked as `bash …`, since packagers strip the executable bit (#2301). Recorded so it is not removed later: kiln's three-dot `<base>...HEAD` is merge-base semantics and is therefore already immune to the phantom-deletion bug #2133 fixed. | 09-20 |
| **D56** | **An empty or non-descendant diff at REVIEW halts the run — the single exception to D31's "reports, never blocks"** | D31 refused to block on scope divergence because discovery during implementation is legitimate. A diff of *zero* files is not divergence, it is the absence of the thing under review, and it has one common cause: the implementer committed to another branch. Unblocked, REVIEW reviews nothing, VERIFY passes on nothing, SHIP opens an empty PR. Upstream hardened the identical case into a refusal — `review-package` *"rejects empty or non-descendant `BASE..HEAD` ranges (exit 3), so an implementer that committed to the wrong branch can't produce a 'clean' review of nothing"* (#2136, v6.4.1). One condition, one halt, no new mechanism: `blast.mjs` already computes the actual list. | 09-20 |
| **D57** | **A `state.verify[]` entry carries `at` and the `HEAD` it ran against; an entry older than the last source write is stale, not evidence** | The record was `{id, cmd, exit, ms}` — a duration, not a time, and no commit — so a green run followed by further edits was still reportable as "12/12, all exit 0", and Section G's audit check 3 (reconcile `verify[]` against the report text) could not detect it. That is D7 item 3 surviving inside its own evidence store. Corroboration: superpowers #2286, *"the skill requires fresh evidence but never asks where the evidence came from"*. Two fields; the staleness rule is what both the final report and the post-run audit read. | 09-20 |
| **D58** | **`state.json` carries `stage` and `step`, and D24's resolution branches on `halted`** | D24 promised that `in_progress` *"resumes at the stopped step"* against a state file recording no stage and no in-flight step, and it never branched on `halted`, which §3c creates. Corroboration that the missing in-flight record has a real cost: superpowers #2293, *"the ledger records no in-flight task, so an outage mid-task re-dispatches work that is already committed"*, plus #2253 and #2267, where deferred findings and cross-task discoveries are lost at finish — which is the job `carry_over[]` was named for and which therefore now has a shape, `{from_pass, kind, text}`. A `halted` work resumes by re-presenting the halt's numbered menu, never by continuing past it. | 09-20 |
| **D59** | **Tracker text is untrusted input, and D7 item 6 is narrowed to what is provable** | Nothing in the design treated a ticket body, a PR comment or a fetched page as attacker-controllable, although §4 chose its exam subject *because* its issues are rich prose and one of them proposes its own fix. Two consequences. **(a)** The investigate skill treats fetched text as data, never as instructions: a URL or a command found in a ticket is reported, never followed or executed, and a ticket asserting that the tests pass is not evidence — D7 item 3's rule, applied to the input side. **(b)** Item 6 read *"never sends anything to the network outside the declared tracker/VCS"*, while D35's proof is a static grep of kiln's own source, which says nothing about the agent following a URL a ticket asked it to fetch. It becomes **"kiln's own code performs no network egress"** — the claim the grep actually proves — and the agent-side risk is named as a ceiling rather than implied to be enforced. Precedent for the severity: agent-skills #295 finding 1, rated Critical, is SSRF because a hook followed redirects on a URL that arrived from tool input. | 09-20 |
| **D60** | **Six unspecified P0-surface behaviours, answered together** | Each sat at a point where an implementer would have had to guess. **(1)** A `steps[]` entry whose `${cmd.x}` key is absent from config fails `kiln doctor` and refuses to run — never a silent skip; D40 rejected "skip when the script does not exist" and this is the same question from the other side. **(2)** `run` executes through the platform shell, because a stack author writes `npm test && npm run lint` and expects it to work — which is *why* no safety regex may live in config (D30) and why interpolation is restricted to `cmd.*`. **(3)** `branch_pattern`'s `${type}` is the classifier's conventional prefix (`feat` / `fix` / `spike`) and `${slug}` is D51's slug. **(4)** `kiln init` over an existing `.kiln/` is additive: it reports what exists, writes only what is missing, overwrites nothing, and points at `kiln doctor --write` — BMAD #2879 is this bug. **(5)** With no git repo or no commit yet, `init` still works and the run refuses at the first stage needing a base, naming it — superpowers #2242 is this crash. **(6)** Config and state reads strip a UTF-8 BOM before `JSON.parse`, which throws on one, and never rewrite line endings — BMAD #2725 silently dropped BOM'd files and rewrote CRLF files wholesale. | 09-20 |
| **D61** | **`node-lib` and `node-prisma` are not stacks — both are `stack-node` with different config, and Prisma is the second adapter exercising the effect point** | §4's subject table named two stacks §3 does not ship, which would have grown v1 scope through the test plan rather than through a decision. Under D30 a Prisma migration is a legitimate effect (it changes DB schema, which the file-level triple cannot describe) and under D29 its generate/migrate commands are steps — so umami is `stack.id: "node"` with one effect and a `requires`, and zod is the same stack with a short `steps[]` and `guards: []`. This closes the weakness D30 recorded against itself: the effect extension point is exercised by two adapters, which is what D10 asks of every extension point. | 09-20 |
| **D62** | **The four vendored upstream skills are namespaced `kiln-*`** | §3b's refusal list said kiln *"does not duplicate their skills"* while §3 vendors four of them — and the most likely kiln user is someone who already runs superpowers, who would then hold two skills named `brainstorming`. Precedent: agent-skills #569, a plugin re-injecting its router *"which is the double routing #557 tells users to avoid"*, and #95, a bundled `/review` colliding with the harness's own. So the copies register as `kiln-brainstorming`, `kiln-writing-plans`, `kiln-executing-plans`, `kiln-subagent-driven-development`, with `NOTICE` recording provenance (D26), and the refusal list is corrected to what is true. Rejected: depending on an upstream install — D6's stranger must not meet "now install a second plugin" in their first ten minutes, and a floating upstream would silently change kiln's gates. | 09-20 |

#### Post-test entries (2026-09-20, from §1.6)

| # | Decision | Rationale | Date |
|---|---|---|---|
| **D63** | **The pre-P0 test passed; Q5 and Q6 are closed, and D54's floor gains a third member** | `PreToolUse` + `exit 2` blocks a real `Write` in Claude Code 2.1.270 (§1.6 row 1), so Section A's one distinguishing column — *"hooks block at runtime"* — is measured rather than claimed, and P0 is unblocked. Two of the audit's open questions close with it. **Q5:** a hook that exceeds its `timeout` **allows** the tool, so `"timeout": 5` bounds latency and buys no protection — a slow guard is an open guard, which is what D2's zero-dependency rule and the measured 20–30 ms cold start are actually for. **Q6:** only the wrapped `{"hooks": {…}}` shape registers; the flat form registers nothing and says nothing, so §3f's existing shape is correct and Tier 1 gains a static check that it stays that way — a silent non-registration turns every D7 promise off at once, which is the failure agent-skills #445 describes. Two ceilings the audit expected to have to name turned out not to exist: hooks fire and block under `bypassPermissions`, and they fire and block inside subagents, whose payload carries the **parent's** `session_id` — so D50's binding holds through IMPLEMENT instead of going silent there, which was the risk. | 09-20 |
| **D64** | **`guard-gate` and `guard-sandbox` extend to a narrow set of Bash write verbs — D53's ceiling is partly closed, because the bypass is the agent's default move** | D53 recorded the Bash hole as an accepted ceiling on the reasoning that closing it needs shell parsing, which D34 refused. The test changed the cost side of that trade: when `Write` was blocked, the subagent's **first unprompted retry was `echo "hello" > <path>`** (§1.6 finding 10). A ceiling whose workaround is the blocked agent's default behaviour is not a ceiling, it is the main path — D7 item 4 would have been enforced against nothing in practice. So `pre-bash` additionally inspects for shell **write verbs against a path**: output redirection (`>`, `>>`), `tee`, `sed -i`, and `cp`/`mv` whose destination resolves into project source, reusing D52's resolver. Still **no shell parsing** (D34's line holds): no quoting analysis, no subshells, no `eval`, no interpreters — `python -c` and a heredoc into a script remain uncovered and that residue **is** the ceiling, now small enough to be honest about, recorded in a `ponytail:` comment and graded in Section G. Inventory: `guard-sandbox` ~110 → ~145, re-counted at P1 (D26's own rule about estimates). | 09-20 |

#### Post-source-review entries (2026-09-20, third pass)

Answered by reading what the validated projects actually shipped, not by argument: superpowers'
`executing-plans/scripts/task-done` and `subagent-driven-development/scripts/sdd-workspace`, and
BMAD #2849 — a production report carrying measured numbers. D14's source hierarchy, applied.

| # | Decision | Rationale | Date |
|---|---|---|---|
| **D65** | **No command sets state. A gate record carries the approved artifact's hash and the user's verbatim answer — and D7 item 4 narrows to the half that is enforceable** | D48 made `state.json` a security boundary and left no writer, so the mechanism D7 item 4 rests on did not exist (audit B8). The cheap answer — put state under `.git/`, which upstream's `sdd-workspace` says the harness protects — is **rejected on measurement**: §1.6 row 10 shows `.git/` is a permission prompt, and `bypassPermissions` writes through it. The shipped shape to copy instead is `task-done`, which **performs the action, reads the real exit code, and records only what it observed** — *"A failing command records nothing: the task is not complete."* So kiln has **no `kiln gate approve` verb and no state-setting verb at all**; every write is the side effect of a command that does something and records what happened. One limit must be stated rather than engineered around: the user answers in chat, so **the agent is unavoidably the courier**, and no mechanism in this harness makes a gate decision unforgeable. The split: **enforceable** — a gate record stores the **hash of the artifact it approved**, so a plan edited after approval fails the check and `guard-gate` blocks again, which is upstream's own v6.4.1 fix (*"Approving an idea or a scope no longer counts as approving a plan you haven't seen"*, #2258); **audited, not claimed** — the record stores the user's answer **verbatim** and the final report and PR body print it, so a fabricated approval is a visible lie in the user's own words rather than a silent flip, the same instrument D42 uses for exit codes. D7 item 4 therefore reads: *no source edit occurs without a gate record matching the current artifact* — enforced; *the record faithfully reflects a human's answer* — audited. Adds one conformance test: approve, edit `plan.md`, assert the next source write is blocked. | 09-20 |
| **D66** | **Guards ask who owns this path, not which work is active — and a second session on one work takes over out loud (supersedes D50's sole mechanism)** | D50 keyed everything on matching `session_id`, whose "no match → ALLOW" branch created a worse hole than the one it closed: a second session resuming work 42 rebinds the id, and the first session keeps working with its guards silently off. BMAD #2849's contract is the answer, from a production report: *"Before modifying a path, check whether another active build has claimed it. **Disjoint path sets may proceed concurrently. An overlapping claim should stop with a clear conflict** rather than overwrite or absorb another story's work."* kiln already holds the claim set — `state.predicted[]` (D31) — so the guard's question becomes ownership, not identity, and the fail-open branch stops being load-bearing. Rules: a write to a path claimed by another **active** work → BLOCK naming the owning work id; disjoint claims run concurrently; same work, new session → the new session **adopts and records the handover**, and the old session's next guarded write BLOCKs with *"work 42 was taken over by another session"* — modelled on `sdd-workspace`'s ownership marker, where *"a workspace owned by a different plan is skipped"* and a marker-less one is adopted. `session_id` survives as the handover record, not as the gate. Standing constraint adopted with it, and it matches D38: *"Attribution must work in the current checkout and must not require creating a Git worktree"* — BMAD names submodules, X++/D365 and fixed absolute build paths, and UNIOSS is a four-module submodule layout, so **kiln may not solve isolation by requiring a worktree**, which is the route superpowers takes and the one that does not transfer. | 09-20 |
| **D67** | **Four corrections carried straight out of BMAD's measured resume, including one that promotes an audit medium to a law** | All four were observed in production, not reasoned about. **(a) `last_verified`.** Keep the run's `base` immutable as provenance and add a moving anchor; REVIEW anchors on `last_verified`, not on `base`. Their number: resuming from the original baseline produced a review artifact **over 100 MB and 1.7 million lines** because it swept unrelated history. This also corrects **D57** — a `verify[]` entry records the **range `base..HEAD`**, which is the shape `task-done` writes, rather than the timestamp D57 proposed; a sha range is comparable against the tree, a wall-clock time is not. **(b) The diff stays file-backed.** Statistics and changed paths into the conversation, body into a file read on demand — their parent agent loaded the whole 100 MB. **(c) Attributable commit, promoted from audit item M6 to a law:** *"stage and commit only the current run's attributable files; never use a broad worktree commit merely because the repository is dirty"* — an explicit path list, never `git add -A`. M6 was reasoned; this is the same finding from a real run. **(d) Resume does not trust its own checkboxes:** *"Checked boxes alone should not be trusted, but they should trigger a cheap preflight rather than an unconditional full implementation pass"* — refines D58, which recorded position but said nothing about believing it. | 09-20 |
| **D68** | **kiln's third path is named `full`, not upstream's `architectural`** | Recorded because it had been renamed silently, which §6.1 rule 5 forbids — a decision without an entry did not happen. `architectural` describes the *kind* of work; kiln's paths name **how much ceremony** the work gets, and the heaviest path is routinely the right answer for a large non-architectural change. `full` also reads as the top of a ratchet, which is what D12 makes it. Cost: a reader who knows superpowers meets one renamed term, so §1.4's mapping stays visible rather than being quietly reconciled. | 09-20 |

#### Post-review entries (2026-09-20, fourth pass — pre-build design review)

The fourth pass read the **sources** of the four skills §3 vendors, at the v6.4.1 tag D55 pins,
rather than their release notes; re-attacked the mechanisms passes 2 and 3 introduced; and closed
the three owner-parked medium items. Three blockers, one high, two mediums. As before, none asked
for a redesign.

| # | Decision | Rationale | Date |
|---|---|---|---|
| **D69** | **The vendored upstream skills are a fork taken at v6.4.1, not a tracked pin — and the dependency closure resolves to five skills plus one reference file** | Measured 2026-09-20 by reading the v6.4.1 sources: `executing-plans` hard-requires six skills kiln does not ship — `using-git-worktrees` at Setup, `test-driven-development` and `verification-before-completion` as **REQUIRED SUB-SKILL**, `systematic-debugging`, `requesting-code-review` (also by the relative path `../requesting-code-review/code-reviewer.md`), and `finishing-a-development-branch` at Finish — and it resolves its workspace through `../subagent-driven-development/scripts/sdd-workspace` into `.superpowers/sdd/<plan-basename>/progress.md`. `writing-plans` names `subagent-driven-development`/`executing-plans` as REQUIRED SUB-SKILL inside the plan header it emits, and saves to `docs/superpowers/plans/`. So "vendor four, pinned to upstream" was not implementable: it ships dangling references (agent-skills **#361**, **#136**, **#67** are this class), it imports a **second identity model and a second state store** beside `.kiln/work/<id>/state.json` — the subsystem D18 deleted — and its Setup step instructs the worktree D66 forbids. A pin cannot fix any of it, because every fix is an edit to the vendored text. **So: fork.** The copies are taken once from v6.4.1, edited to fit, and owned by kiln; there is no next merge — which is what made D26's "keep upstream style or conflict on every release" clause load-bearing and D62's rename expensive. Both costs vanish. The closure resolves as: **vendored** — `kiln-brainstorming` (with the companion, D11), `kiln-writing-plans` (saves to `work/<id>/plan.md`; its Execution Handoff is cut, the orchestrator already chose), `kiln-implement` (from `executing-plans`: task loop, completion contract and rationalization table kept; ledger repointed at `state.json`; Setup-worktree, Final Review and Finish cut), `kiln-tdd`, `kiln-debugging`; plus `code-reviewer.md` as a **reference file** under kiln's own review skill, which costs zero always-on description. **Dropped, with reasons** — `subagent-driven-development` (duplicates `kiln-implement` once the ledger is repointed; v1 runs native), `using-git-worktrees` (D66), `finishing-a-development-branch` (duplicates SHIP), `verification-before-completion` (kiln mechanizes it — exit codes, `verify[].range`, the staleness rule; D20's "mechanize, don't document"). Skill count stays at 8, so the context budget does not move. **The cost, stated rather than sold:** §1.4 measured unioss's silent drift from upstream as a defect and kiln now chooses that state deliberately — upstream's future measured fixes will not arrive on their own. The difference is that the fork commit is recorded in `NOTICE`, and P5's release checklist carries one human step: read upstream's releases since the fork commit and adopt by a decision entry, never by a merge. | 09-20 |
| **D70** | **The guards ask two questions and resolve them by two keys: `session_id` answers *which work is mine*, `predicted[]` answers *who owns this path*** | D66 replaced D50's identity gate with ownership and left `guard-gate` with no resolver at all: it must read `state.gates` of *some* work, and "which one" is an identity question ownership does not answer — a path discovered during implementation is in no `predicted[]` **by design** (D31), so ownership is silent on exactly the writes `guard-gate` exists to judge. The two are not alternatives. **Identity** selects whose gate record applies (`session_id` from hook stdin, rebound by `/kiln <arg>`, handover recorded per D66); **ownership** decides whether another active work has claimed the path. D66's supersession of D50 is therefore narrowed to the authorization half. Second correction, to a number: answering the ownership question means reading every `in_progress` work's `state.json`, not one — D32's budget said "one small `state.json` read". Shape: a `readdir` of `.kiln/work/` plus one read per `in_progress` entry, in practice one to three, against a node cold start of 20–30 ms that dominates it. No index file is added: D50's objection was to *inferring the active work* by scanning, not to reading claims. | 09-20 |
| **D71** | **The gate writer is named: one command that reads the user's answer, hashes the artifact itself, classifies the answer, and records what it observed** | D65 said kiln has "no `kiln gate approve` verb and no state-setting verb at all", which left `gates.<key>` — the field D7 item 4 rests on — with no writer. The two statements reconcile only by naming the shape D65 itself copied from `task-done`: a command that **does something and records what it observed**. What this one does is not "set a gate". It reads the user's verbatim answer, **computes `artifact_sha` from the artifact on disk** (the half no agent can forge, D65), classifies the answer against D21's explicit-yes list — "whatever you think", "sounds good", silence are not yeses — and writes `{decision, artifact_sha, answer, by}`. The agent supplies only `answer`; every other field is observed. It runs through `Bash` as `node`-invoked kiln code, while `Edit`/`Write` on `state.json` stays blocked (D48). The residue is D64's and is named there: a `Bash` interpreter can still write `state.json` directly, which is why `answer` is printed verbatim in the final report and the PR body — a fabricated approval is a visible lie in the user's own words, not a silent flip. | 09-20 |
| **D72** | **An overlapping claim is refused when the claim is registered, never first when a write hits it** | D66 adopted BMAD #2849's contract — *"an overlapping claim should stop with a clear conflict"* — but placed the check at write time, where it produces the opposite: work A claims `src/x.ts`, work B's approved plan claims it too, each blocks the other's writes, and neither can proceed. A mutual block is not a clear conflict; it is a deadlock with two error messages. The check belongs where the claim is made: `predicted[]` is written once, as the side effect of the plan gate (D31, D71), and that is the moment to compare it against every other `in_progress` work's claim set and halt naming the other work id. Write-time blocking survives as the backstop — for a claim registered before this rule existed, or a work resumed out of order — but is no longer the primary detector. No upstream issue reports this shape: it is reasoned, not measured, and §6.1 rule 2 requires saying so. | 09-20 |
| **D73** | **`verify` is cut — a browser check is a step (closes M8)** | Two mechanisms meant "run checks": `verify.provider` (skill text, the agent driving Playwright through its own MCP/CLI) and `stack.steps[]` (code, exit code, evidence into `state.verify[]`). Only one produces auditable evidence, and D7 item 3 rests on that evidence — so the skill-text path was the weaker half of a duplicated concept. A Playwright run is a step with a `run` and an exit code. Removed: the `verify` config key, its three provider values, and §4's Verify column. A stranger stops having to learn which of two mechanisms runs their tests (principle 3). | 09-20 |
| **D74** | **The PR body cites `state.verify[]`; no log content is written to the remote (closes M7)** | M7's conflict was that `tmp/<id>/` is deleted at the end of SHIP while the PR body cited the step logs it holds. The owner's ruling settles it from the other side: log content does not belong in a pull or merge request on the remote at all. The PR body carries the run's rows from `state.verify[]` — `{id, cmd, exit, range}`, committed and durable — inside the body's fixed format. Raw logs stay local, are read on demand during the run (D67b), and `tmp/` is still deleted at the end of SHIP. No retention mechanism, no tracker polling (which D13 refuses to write), and the evidence a reviewer needs is the part that survives. | 09-20 |
| **D75** | **Review findings carry a likelihood axis, and a minimum finding count is forbidden (closes M9)** | Both halves are a validated project's measured failure. agent-skills #436: *"findings ranked by consequence only … improbable findings block merges"* — severity alone lets a catastrophic-but-impossible finding outrank a certain-but-moderate one. BMAD #2772: *"one review layer's quota manufactures findings"* — any floor on the number of findings is an instruction to invent. So `review.md` grades each finding on both axes, and the review skill states that zero findings is a valid result. Cost: one column and one sentence. It pairs with D55's adopted rule that unspecified behaviour is judged by what a reasonable user would expect, and with its **Declined to judge** list — severity, likelihood and declination are three different things and the review must not collapse them. | 09-20 |
| **D76** | **`last_verified` starts at `base` and advances only when a whole `full`-phase set exits 0** | D67a introduced the moving anchor and named what it prevents, but gave neither its initial value nor its update point, so an implementer had to guess both. It is set to `base` when the work is created, and advanced to the `HEAD` a `full`-phase step set ran against **only when every step in that set exited 0** — a failed or partial run leaves it where it was, or the next REVIEW anchors on a commit nothing verified. `base` never moves (D67a). On a resume, REVIEW's range is `last_verified...HEAD`, which is why a week-old resume reviews its own pass and not the repository. A `fast`-phase pass never advances it, for the same reason it is never reported as green (D55). | 09-20 |

#### Post-user-review entries (2026-09-20, fifth pass — the owner read the design back as a user)

The fifth pass came from the owner reading an inverted, user-seat description of this design and
asking three questions about it. Each landed on something the design asserted without a mechanism,
or left to a guess. Two of them (D77, D81) are holes the builder-seat passes had walked past four
times.

| # | Decision | Rationale | Date |
|---|---|---|---|
| **D77** | **Opening a pull request is gated, and the authorizing gate is per-path — `spike` can never open one** | §3c asserted *"ship is blocked separately (D12)"* and named no mechanism, because there was none: `spike` simply has no SHIP stage, and nothing stopped the agent from running `gh pr create` itself. Reading that as enforced is the overstatement D7 item 3 exists to prevent. Checking it exposed the larger hole: **on `full`, the `ship` gate was prompt-only too** — nothing prevented a PR before gate 4 — which is the weakness kiln claims to fix, sitting in kiln's own heaviest path. One table closes both, reusing D49's exact shape: `SHIP_AUTHORIZING = { spike: null, bounded: "review", full: "ship" }`, where `null` means never authorized. `pre-bash` matches the PR-creation verbs (`gh pr create`, `glab mr create`) and BLOCKs unless that path's key is approved; `bounded` maps to `review` because its review accept **is** accept-and-ship (§3e). Still no shell parsing — D34's line holds, because this is a command-name match, not a path resolution. Residue, named rather than claimed away: the forge's web UI and a direct API call are outside it, and a push to a protected branch is already `guard-protected-branch`'s. Graded in Section G as a ceiling, like D53 and D64. It is deliberately **not** an eighth D7 test: item 4 is about source edits, and inflating the list would blur what the seven actually prove. | 09-20 |
| **D78** | **The ratchet out of `spike` never touches the working tree; it halts with a numbered menu and records itself in `carry_over[]`** | D12 made `spike → bounded` a one-way ratchet and never said what becomes of the throwaway source. It matters more than it looks: SHIP is kiln's only commit point (D36), so a spike's code is **uncommitted working-tree changes** — and deleting them would be D7 item 2, *destroys data unasked*, performed by kiln itself. Carrying them forward silently is the opposite failure: they were authorized by the `probe` gate, not by `plan`, so they would launder pre-plan code into a shipped change while D65's rule — no source edit without a gate record matching the current artifact — was satisfied by a record for a different artifact. kiln therefore does **neither** on its own. The ratchet is a halt with the numbered menu every other irreversible choice already uses: it prints the spike's `git diff --stat`, states that anything kept will surface at REVIEW as *beyond prediction* — the reconciliation doing its job, not a new warning — and leaves the tree exactly as it is whichever option is chosen. The ratchet itself is recorded as `carry_over[] = {from_pass, kind: "ratchet", text}`. No new mechanism, nothing destroyed, and the consequence is reported by an instrument that already exists. | 09-20 |
| **D79** | **`/kiln dna` is a fourth command, shipped at v1.2 with the tier it serves** | D24 closed the surface at three, and its reasoning was *"a command that duplicates what state already answers is not a command"* — which is why `resume`, `feedback` and `ship` collapsed into `status`. `dna` duplicates nothing: no state field and no argument shape means *show me the knowledge store* or *refresh it now*. An earlier answer in this pass — make both skill text, per D13 — applied D13 on the wrong axis: D13 decides whether something must be **code**, not whether it deserves a **command**, and `kiln doctor` is likewise not enforcement. The deciding axis is D6: a stranger cannot discover skill text, because invoking it requires already knowing the explorer exists. Surface: `/kiln dna` opens the explorer · `/kiln dna init` full scan · `/kiln dna update` diff scan · `/kiln dna --export` the single self-contained HTML file. Four refinements, each closing a question the bare proposal left open. **(1)** `update` always runs against `origin/<integration_branch>` after a fetch, whatever branch the user stands on — the one always-correct behaviour, so it needs no flag (D80, D82). **(2)** `update` on an empty store **refuses and points at `init`**, never bootstraps silently: bootstrap is a full scan and update is a diff scan, two genuinely different procedures (`bootstrap-playbook.md` against `update-playbook.md` §1 *"Diff, don't re-scan"*), and a full scan of a large repository is not something a command named `update` should start by surprise — the same law as D60.1 and D39. **(3)** `--export` is a flag, not a subcommand: same object, different delivery. **(4)** `init`, `doctor` and `dna` become **reserved words**, resolved before every branch of D24's order, and a work id may not take one — otherwise `work/dna/` shadows the command. D51 already refuses colliding ids, so this is that mechanism plus one sentence. v1 is not reopened: the surface there is still three, a v1 user never meets `dna`, and at v1.2 the command adds no concept — DNA is already the concept; the command is what makes it findable. | 09-20 |
| **D80** | **The DNA store is scanned and pinned only on the integration branch; a manual refresh may preview anything but may write `source_pins` from nothing else** | D22 fixed the drift *comparison* to `origin/<integration_branch>` and never said which branch the **scan** runs on — leaving `source_pins`, the anchor that comparison stands on, undefined. The two must agree or the comparison means nothing: a scan pinned to a commit on `feat/…` makes the next drift check compare the user's own unmerged work against the integration branch, which is the exact bug D22 exists to prevent, re-entered from the write side. So the pin has one source. `/kiln dna update` (D79) runs against `origin/<integration_branch>` regardless of the working branch, and a scan anchored anywhere else may produce a preview but **may not write `manifest.source_pins`**. This also closes the question the manual command opened: manual and automatic do not get two anchors — they get one anchor and two triggers. | 09-20 |
| **D81** | **`integration_branch` is per module when `repo.kind` is `multi`** | A measured contradiction inside the existing config: `manifest.source_pins` is a **map keyed by repo** (`{"<repo>": "fdafa754e", …}`, §1.2) while `vcs.integration_branch` is a **single scalar** (§3g). UNIOSS is the case that breaks it — four modules, two apps that own tickets and two submodules — and nothing guarantees four checkouts share one branch name; `v3-master` in §3e's own guard test table is the evidence that these names are not uniform even inside one organisation. With one scalar, D22's drift check and D80's pin rule are correct for at most one module and silently wrong for the rest. Shape, kept minimal per D37's anti-growth ratchet: `integration_branch` stays a string for the single-repo case and accepts a `{ "<module>": "<branch>" }` map when `repo.kind` is `multi`, each unlisted module defaulting to the scalar. The map's keys are **`repo.modules`' keys**, which are also what `manifest.source_pins` is keyed by — one key space, named once, so an implementer does not have to infer that "repo" and "module" mean the same thing from two sections that use two words. No new top-level key, so the ratchet is satisfied by this entry alone. | 09-20 |
| **D82** | **The drift check fetches before it compares, and a failed fetch is reported rather than counted as zero drift** | D22 compares `manifest.source_pins` against `origin/<integration_branch>`, which is a **local ref**: with no fetch it can be weeks old, and the check then reports *no drift* for a branch that has moved by hundreds of files. That is D7 item 3's exact shape — a stale measurement presented as a clean result — sitting inside the instrument whose only job is telling the user how much they do not know. `guard-protected-branch` already allows `fetch`, `pull` and `checkout`, so nothing had to be unlocked; what was missing was the requirement. The check fetches first; if the fetch fails (offline, no remote, auth), the drift number is **not printed as zero** — the failure is named, DNA is used with the whole store marked low-confidence, and the catch-up offer defaults to no. That is D22's own large-drift branch reused, not a new one. | 09-20 |
| **D83** | **D7 item 6's allowlist covers the Python tier explicitly, and a loopback listener is distinguished from egress** | D35 proves item 6 with a CI grep for `fetch(` / `node:http` / `node:net` — a **Node** grep, which says nothing about the ~7,500 Python lines arriving behind the Knowledge port at v1.2. Measured in the source it will vendor: `serve_store.py` (95 lines) runs `ThreadingHTTPServer(("127.0.0.1", port), …)` and calls `webbrowser.open` — a **listener bound to loopback**, not egress, and a legitimate one, since a local explorer is the point. But an allowlist that never mentions Python does not *permit* it, it **fails to look**, and an unexamined tree is not a proven one. Two rules, both static, both in D35's honesty style: the grep extends to the Python tree (`urllib`, `requests`, `http.client`, `socket.connect`) with `http.server` bound to `127.0.0.1` on the allowlist **by name**; and item 6's wording gains the qualifier that a loopback listener is not egress. If either proves uncheckable at v1.2, the correct move is to record the Python tier as **ungraded** — never to leave a grep that reads as covering it. **Third rule, forced by D82 and found in the final pass:** D82 makes **kiln's own code run `git fetch`**, which is network egress, while D59's narrowing had reduced item 6 to *"kiln's own code performs no network egress"* — dropping the original qualifier *"outside the declared tracker/VCS"* and thereby making the claim false the moment the drift check fetches. Item 6 reads: **kiln's own code performs no network egress except `git fetch` / `git ls-remote` against the remote named in `config.vcs`**, and the allowlist names those two by verb. Everything the *agent* does with `gh`/`glab`/MCP was already outside item 6 (D13, D59); this closes the half that is kiln's. | 09-20 |
| **D84** | **The explorer's template name is reconciled at vendor time, not at v1.2** | Measured in the source that will be vendored: `export_static_explorer.py` reads **`explorer-v2.html`** while `assets/` ships **`explorer.html`** (117 KB, beside `laneflow.js` at 81 KB). One of the two is wrong today, and whichever it is, the failure surfaces as a stranger's export producing nothing — at v1.2, in someone else's hands, long after the fix was cheap. It is recorded now because the script's own design constraint is why it matters: *"there must be exactly one copy of the UI. A hand-written static version is a fork, and a fork silently rots."* A filename mismatch is that fork, arriving by accident. The reconciliation is a vendor-time step in the same checklist as D69's fork point, and the vendored front end (≈ 198 KB) lives under `vendor/`, excluded from lint, beside the visual companion. | 09-20 |

| **D85** | **Opening pass N+1 clears `gates` and `predicted[]`; `base` and `last_verified` advance to the shipped HEAD; `carry_over[]` survives** | D24 promised that a `shipped` work *"opens pass N+1 after confirmation"* and `state.json` carries `pass`, but nothing in eighty-four entries said what becomes of the gate records — so pass 2 would begin with every one of pass 1's gates still reading `approved`, and two of D7's promises would turn off at once: `guard-gate` sees `gates.plan == approved` and permits source edits before pass 2 has a plan (item 4), and D77's `SHIP_AUTHORIZING[bounded] = "review"` sees `gates.review == approved` and permits a PR nothing reviewed. **`artifact_sha` does not cover this**, and the reason is worth stating because it inverts: the hash catches an artifact that *changed*, while here the artifact is **unchanged and that is the problem** — `plan.md` was approved for pass 1's work, so a matching hash is the wrong signal rather than a reassuring one. D65's hash rule was also written only about the gate that authorizes source edits; it now reads on **every** gate key. The reset is the whole fix, because a gate record belongs to the pass that earned it: `predicted[]` goes with it, being pass 1's claim set and therefore wrong input to D72's overlap check; `base` and `last_verified` advance to the HEAD that shipped, per D67a's rule that REVIEW never anchors behind what was already verified; `carry_over[]` is the one field designed to cross the boundary (D58) and is untouched. Resuming an **unfinished** pass does not increment `pass` and is unaffected. Same family as superpowers #2138 and D51 — a previous unit of work's approval read as current. Found by attacking **D77, itself the fifth pass's own fix**, which is §6.1 rule 9 holding rather than failing. | 09-20 |

#### Post-construction entries (2026-09-21, from building it and running it)

Construction and six acceptance runs produced nine defects. Most were implementations
falling short of a decision already written; the four below changed a decision, and are
recorded here rather than left in a pull request. Evidence:
`2026-09-21-live-harness-evidence.md` and the five acceptance records beside it.

| # | Decision | Rationale | Date |
|---|---|---|---|
| **D86** | **A stack's `steps[]` is a default the project's config replaces, and `init` writes the set it can satisfy** | D40's own title says *"`stack-node` ships no `lint` step; `kiln init` **adds one when it detects** a `lint` script"* — so steps were always meant to be detected. The implementation left them in the stack file and shipped `typecheck` unconditionally, which a plain JavaScript project can never satisfy: `init` warned, `doctor` failed and `verify` refused, on the most common Node project there is. `stacks/node.json` now ships the one step every Node project has; `init` adds `typecheck` with a tsconfig and `lint` with a lint script. D60.1 is unchanged and is why this had to be fixed here rather than by skipping: an unsatisfiable step must refuse, so it must not be written in the first place. | 09-21 |
| **D87** | **A blocking unknown halts. It is not a downward ratchet, and there is no downward ratchet** | Acceptance run C4 hit an unanswerable question on the `full` path — *which* third database backend, since a second OLAP store slots beside ClickHouse while a second relational store replaces Prisma — and recommended *"drop to spike"*. The code refused it correctly (D12), but the skill stated the ban without naming the alternative, so the agent reached for the only move it knew and had nowhere to go. The gap was never the ban: D12 exists so a task that proved large does not become cheap again because investigating it was tiring, and what C4 found was a different thing — not *smaller than we thought* but *not buildable yet*. The move is: name the unknown and what each answer would change, halt with `carry_over[] = {kind: "blocking_unknown", text}`, and offer two futures — answer it and continue, or **close this work and open a spike**. The second stays the user's to take, because closing a work is a decision about their time. | 09-21 |
| **D88** | **The integration branch is the remote's default branch, never the branch the user happens to be standing on** | Measured on a clone of zod while standing on a feature branch, which is how anyone tries a new tool: `init` recorded `protected: ["feat/kiln-acceptance"]`, and `git push origin main` returned **exit 0**. D7 item 1 — the project's first promise — defeated by the ordinary act of running `init` on a branch, with `guard-protected-branch` working perfectly and guarding the wrong thing. Read from `refs/remotes/origin/HEAD`, falling back to the current branch only when there is no remote to ask; `kiln doctor` fails when the branch a repository ships from is not protected. Confirmed on a third repository that does not use `main`: umami detected `master`. | 09-21 |
| **D89** | **Work already uncommitted when a run opened is subtracted from the reconciliation** | `git status` has no notion of *since*, so every file the user had left lying around — and, on a first run, kiln's own `.gitignore` line — was reported as **beyond prediction**. P4's bankruptcy condition is that tier-0 reconciliation becomes noise people ignore, and a line that cries wolf gets there quickly. The set is recorded at `open` as `dirty_at_open[]` and subtracted at `scope`. A file the plan **claims** is still the run's doing even if it was already dirty: the subtraction is for work the run did not touch, never for work it did. | 09-21 |
| **D90** | **A `pre-push` hook is installed in every checkout as the floor under `guard-protected-branch`, and the PreToolUse hook is what keeps it armed** | Measured, standing on a protected branch: `git push origin HEAD`, `@`, `-u origin HEAD`, `--force origin HEAD`, `+main` and `git push origin` were all ALLOWED, and `git -C <submodule> push` was judged against the superproject's branch. Each was a separate patch to the scan, and the scan can never be finished: a command line does not say which checkout, which branch or which config were in play, and git computes those in more ways than a scan enumerates. The prior art is decisive — house-rules hardened the same scan to **1437 lines, 289 assertions and +60% latency** and it fell to a new bypass every adversarial round. So the decision is a **floor plus a ceiling, not a better scan**. Floor: git's own `pre-push`, handed the resolved `<local ref> <local sha> <remote ref> <remote sha>` on stdin **after** git has worked everything out, so it parses nothing and is correct per repository by construction. Ceiling: the forge's own branch protection, named in the README as the user's setting, not kiln's. What stays with the PreToolUse hook is the one job the floor cannot do — it is bypassable, so `--no-verify`, `-n` on commit, `core.hooksPath` and the `GIT_CONFIG_*` env overrides are refused there, and `.git/hooks/` and `.kiln/hooks/` join the files a run may not write. That division is deliberate: inferring runtime state from a string is unreliable, matching a literal flag is not, and the flag set is finite and documented. Four constraints follow. **(1)** A hook already present is **reported, never replaced** — a project's own hook is not kiln's to take, and D60.4's overwrite-nothing law has no exemption for safety. **(2)** `core.hooksPath` set elsewhere means the file kiln writes would never run, so that is a finding, not a silent success. **(3)** The runner lives at `.kiln/hooks/pre-push.mjs`, inside the project and committed, so it survives a plugin update and a stranger can read what runs in their repository — SECURITY.md already calls hooks a supply-chain surface. **(4)** Nothing at runtime can notice a hook that was never installed, so `kiln doctor` carries it, which is D54's floor argument applied to a second thing that fails open by absence. | 09-21 |
| **D91** | **One unit of work spanning several repositories ships as a topic — N pull requests sharing the work id — and the two things that cannot be promised are printed** | D81 established that a multi-module checkout has per-module integration branches; what it never said is what SHIP does when one ticket touches four of them, and v1 assumed one work = one repository = one pull request. The proven shape is Gerrit's **topic**: a string shared by every change, which Android's `repo` uses across hundreds of repositories. kiln already mints such a string — the work id — so the topic is not a new concept, and D37's ratchet is satisfied without a schema field. `kiln ship <id>` groups the run's own diff by the module that owns each path (D81's key space, now detected from `.gitmodules`) and prints one row per repository with the branch it targets. Two limits are **printed rather than papered over**, both taken from Gerrit's own documentation: a topic only triggers submission, so a **partial merge is possible**, and **merge order is not derivable** from the repositories — inventing a dependency graph would be the confident wrong statement this project exists to refuse, and GitLab has no cross-project submit to make the promise true. The plan also gives `vcs.branch_pattern` its first reader, and a placeholder the work cannot fill is named rather than shipped as the literal text `${type}` in a branch name — D60.1's law applied to a second unresolved substitution. What stays open and is not pretended shut: when the third pull request fails after two have merged, kiln has no answer beyond reporting it. | 09-21 |
| **D92** | **`init` asks what detection cannot answer, not a fixed three — and the answers go in before the file is written** | §3b fixed the list at three: protected branches, test command, tracker. Measured on a real setup, the limit did not reduce the questions, it **moved** them: `init` never asked which branch pull requests target, wrote `main` for a project whose modules ship `v3-master`, and `kiln doctor` asked the same thing afterwards with the file already on disk — after which the agent rewrote `.kiln/config.json` itself, which is the file D48 says it may not touch. The count was never the law; not interrogating the user is. So two questions are always asked, because neither is ever readable from disk (what must never be pushed to, what runs the tests), and the rest appear only where detection is blind: `stack.id` when the checkout looks like several stacks, `vcs.integration_branch` when nothing names a default branch, `tracker.provider` when no remote names a forge. Typical projects are asked **two**, fewer than before. Two mechanisms make it real, because a question nobody asks is a value nobody chose: the orchestrator runs `init --propose`, asks, then `init --set`; and bare `init` prints every question it answered on the user's behalf, so a person using the CLI directly sees what was decided for them. Detection also stopped being blind in the way that produced the worst answer — it reads the submodules' remotes, since a superproject usually has none of its own. | 09-22 |
| **D93** | **Quotes are read, because whether a character is syntax or data is settled before anything runs** | Measured on a company monorepo: a read-only `mysql -e "SELECT ... HAVING COUNT(*) > 1"` was refused as a source edit. The scan read `> 1` as a redirect into a file named `1`, the gate blocked the write it thought it saw, and the agent — correctly declining to route around a block — carried the unverified fact into the spec as an open question. `psql -c "WHERE n > 5"` and `awk "{ if ($1 > 2) ... }"` are the same sentence. D34's line is about not **interpreting** a shell: no subshells, no eval, no interpreters. Reading quotes is not that; `tokens` had applied the rule since the sed-script fix, and applying it to `>` while splitting segments on a quoted `;` is the inconsistency that let a real DDL write go invisible. One lexical walk now answers both. Two coverage holes closed on the way (`cat a>b` and `2> err.log` were never matched at all), and one accidental coverage given up and named: `sh -c "echo x > path"`, which D98 then takes deliberately. | 09-22 |
| **D94** | **A value written as JSON is stored as JSON; one that opens like JSON and does not parse is refused** | D82's rule — a value takes the shape already at its key — is right for a scalar and wrong for a structure. `--set stack.steps=[{...},{...}]` was split on the commas **inside** the JSON, and kiln wrote six string fragments into a real project's `.kiln/config.json`. Repairing it took `node -e`, a direct write to the one file D48 exists to keep out of the agent's reach: kiln corrupted the config and then made the agent reach past kiln to fix it. `git config` settles the same question by never guessing — `--type` is declared by the caller or no canonicalization happens, and a multi-valued key is built with `--add` rather than by splitting a string. Opening with `[` or `{` is the declaration here. Falling back to the comma split on a parse failure is exactly how the corrupt file was written, so it refuses instead. | 09-22 |
| **D95** | **The fast phase is filled by an answer, never by a shipped command** | `kiln verify --phase fast` is the per-task check the implement contract requires. Neither shipped adapter could fill it: `php-ci3` offered only `migrate`, which D86 correctly drops on a project with no migrate command, and `node` offered none. So on a real PHP monorepo the mandatory call refused, the agent ran the suite by hand, and the work reached IMPLEMENT with `verify: []` — eight watched red/green cycles on disk in `.kiln/tmp/`, not one of them in kiln's ledger. There is no portable command to ship: jest has `--onlyChanged`, vitest `--changed`, pytest `--lf`, phpunit `--filter`, go a package path. Inventing a spelling would bake one project's convention into every project's config, which is the specific mistake this project is under instruction not to make. So it is asked, which is what D92 is for, and a blank answer is a real answer leaving the phase honestly empty — a state D96's sibling change teaches kiln to describe correctly rather than to misreport as `"steps" is empty`. | 09-22 |
| **D96** | **A count is not printed from a base the branch never grew from** | `kiln scope` reported `predicted 11 · actual 283` where the real change was the 11 predicted files. `kiln open` had recorded `base` on `v3-master`; the branch was later cut from another ticket's branch, so `base...HEAD` — correct git, merge-base to HEAD — swept in the whole of that ticket. The agent diagnosed it and wrote the reason in the ledger; nobody else reading `283` would have concluded anything but a scope escape. git answers the question directly (`merge-base --is-ancestor`), so nothing is inferred from the size of the number. The remedy is `kiln open <id> --base <commit-ish>`, and it is **on the record**: re-anchoring shrinks every count that follows, so a base moved quietly forward would let a 200-file change report one file — D7 item 3 with kiln supplying the tool. It is typed by a person and appended to `carry_over`, where `kiln report` renders it. | 09-22 |
| **D97** | **The next move rides on the call the contract already makes mandatory, and the position is written by kiln** | The implement skill carries superpowers' rule verbatim — "Do not pause to check in with your human partner between tasks. Execute all tasks from the plan without stopping" — and on a five-hour run the agent stopped twice anyway, forcing the user to type `continue with task 3` and then `Why stop each task?`. It answered: "the skill says run continuously and I've been pausing anyway." It had not decided to ask. Both stops came directly after a **summary table**, and both ended on a sentence announcing the opposite; a summary is a closing gesture and the turn ended on the gesture. Nothing in kiln held the rule — every rule kiln enforces is held by a hook that exits 2, and this one was prose loaded once and five hours stale. `state.step` existed for exactly this and was written `null` twice, read once, set by nobody: the recurring shape, a value computed and read by nobody. Superpowers carries the same rule on a **subagent per task**, so its controller never reaches a task boundary — a structure kiln declined for cost. BMAD writes story status **from the build, not from the agent**, and its #387 and #496 are what prose alone produces. A new verb would be prose enforcing prose, since a verb the agent must remember to call is forgotten by the same drift. So `--task <N>/<total>` rides on `kiln verify --phase fast`, kiln records the position, and the last line of that output is the instruction. The skill also forbids the gesture: no completed-task tables between tasks. Residual, named: with no `stack.cmd.test_fast` the mandatory call is a refusal rather than a run, so the refusal prints the move too — still weaker than a subagent per task. | 09-22 |
| **D98** | **An inline program may not name the files the enforcement is made of** | D93 gave up one accidental block (`sh -c "echo x > path"` no longer trips a redirect scan that now reads quotes), and the older measured case is worse: an agent repaired a config kiln had corrupted with `node -e "...require('fs')... .kiln/config.json..."`, and kiln allowed it. D48 is not "config.json is hard to edit" but "the agent cannot change the terms it is judged by", and an interpreter walked past it — with kiln having made the agent reach for one. The program is **not read**: D34 keeps kiln out of interpreting one shell, an inline program is a second behind the first, and house-rules #58 is the standing argument that a command-text scan can never be finished. What is read is whether the program names a file the enforcement is made of — `.kiln/config.json`, a `state.json`, `.kiln/hooks/`, `.git/hooks/`, `.git/config` — and that alone refuses, because "kiln cannot see what this does" and "this may touch what judges the run" cannot both hold. `node -e "console.log(1+1)"` still runs; the interpreter is not the offence. The B25 ceiling is unchanged and still asserted. | 09-22 |
| **D99** | **The hook finds its runner by asking git, takes the first one upward, and allows when there is none** | Measured on a real monorepo: every push from every one of four submodules died with `Cannot find module '/…/AdminPage/.kiln/hooks/pre-push.mjs'`. `git rev-parse --show-toplevel` inside a submodule is the submodule — git's documentation says so — and `.kiln/` exists only in the superproject. The branch being pushed and its destination were **both unprotected**; the floor never reached a verdict, it died on a path, and the agent correctly refused `--no-verify` and stopped. `--show-superproject-working-tree` is the primitive for the question actually being asked, and three details are measured rather than reasoned. **(1)** Take the **first** checkout upward holding a runner, not the outermost: a project whose kiln lives in the submodule, nested inside a larger repository, would otherwise be judged by a stranger's config — the first draft of this fix got that wrong and a layout matrix caught it. **(2)** Clear `GIT_DIR` and `GIT_WORK_TREE` before walking, because git exports both into every hook and they beat `-C`; left set, a submodule two levels down received an empty answer at the second step and its push to a protected branch went through unchecked. **(3)** No runner anywhere means kiln is not driving this repository (D33) — say so once and allow, because a floor that refuses a push it cannot judge is a wall, which is exactly what the real run hit. Verified by real pushes through real git across twelve layouts, including `.git` as a file and as a directory, two levels of nesting, husky, a worktree, and a standalone clone. The script became `lib/floor/pre-push.sh`, a real file, for the reason the runner already was one. | 09-23 |
| **D100** | **Where the hook goes is git's answer too, and `doctor` reports what will happen rather than that a file exists** | The worse half of D99's pair, and it fails **open**. In a linked worktree `--absolute-git-dir` is `.git/worktrees/<name>`, so kiln wrote its hook there, `floorStatus` read that file back as `installed`, `doctor` printed `Ready.` — and git reads hooks from the common directory. Measured end to end: a real push to a protected branch succeeded, exit 0. That is D7 item 1 reported as held while absent, the same shape as the husky bug `hookDir` was written to fix, one directory over — the lesson *ask git, do not compute the path* had been learned twice here (D90, and the protected-branch guard's refs) and applied to what the hook **contains** but not to where the hook **goes**. `git rev-parse --git-path hooks` answers `core.hooksPath` and commondir in one call. Two further facts `doctor` was asserting without checking: a hook **present** and a hook **able to run** are different (`no-runner` — on the real monorepo all five checkouts reported ok while every submodule's hook pointed at nothing), and a hook carrying kiln's marker was never replaced even when written by an older version (`stale`) — while its own first line reads `Regenerate with kiln doctor --write`, so nobody who had already installed could receive a fix, D99's included. The `foreign` remedy text was also handing out the very line that broke every submodule push. | 09-23 |
| **D101** | **The rules router gets a reader, and a trigger is a path glob matched in code — never a description matched by the model** | D20 mechanized two of its three questions and `kiln doctor` has checked both since `init` first wrote the router. Nothing ever read one. A project could file a rule, route it correctly, watch doctor print `all routed`, and have the agent edit the very file the rule was about without seeing it — the same shape as `state.step` and `"steps" is empty`: a value computed and read by nobody. Prior art settled the form. Cursor resolves rules four ways from three frontmatter fields, and the type behind nearly every report of a rule *being ignored* is the one where the model decides from a `description` whether a rule is relevant; the other reports are malformed frontmatter skipped with **no warning and no log**. Both are unverifiable after the fact, which is the property kiln cannot accept. So: the trigger is a glob, matching is `lib/rules.mjs`, and what was handed over is recorded in `state.rules[]` — *this rule applied* is a fact, not a hope. Two stages, two sets, deliberately: at PLAN the globs meet `predicted[]`, so a rule shapes the plan rather than being remembered after it; at REVIEW they meet the real diff, which is how a rule reaches a file **the plan never predicted** — the case a router seeing only what is already in context cannot cover, and the case where runs go wrong. Every row that does not resolve is named by doctor (a half-filled row, a rule file that is not there, rows with no separator, a glob matching nothing git lists) because a rule skipped in silence has no symptom to debug. `rules.budget_lines` already existed and is the same law Cursor's users arrive at from the other side: past roughly ten always-on rules the model satisfies none of them well. | 09-23 |
| **D102** | **A project rule is one of the terms the run is judged by, so the run may not write one — scoped to a run** | D7 item 7's words are that the agent cannot change the terms it is judged by, and D101 made a rule such a term. An agent that finds a rule inconvenient could otherwise answer it by rewriting the rule, and `state.rules[]` would still claim the run was handed text that is no longer there. Three paths, because no single scan sees all three: the sandbox (Edit, Write, a redirect, `cp`/`mv`), removal verbs (`rm`, `truncate` — which reached only control files, on D34's own reasoning that deleting a file is a stronger edit than writing one), and the interpreter list, where `.kiln/rules/` sits **unconditionally** because an inline program is not how anybody writes a markdown rule and it is how the one path the sandbox cannot see would delete one. The scope is the part that took thought: outside a run nothing is being judged, and a person asking their agent to help write a rule is doing exactly what the router is for. Blocking that would make the feature unusable to set up, so the sandbox check is `activeId`-gated while the interpreter check is not. | 09-23 |
| **D103** | **A refusal kiln intends is never reported as a bug in kiln** | Measured on a clone of zod, whose `README.md` is a symlink into `packages/`. Refusing to follow a symlink is D52 and is right — following one is the arbitrary-file-overwrite primitive agent-skills #295 rates High. The *report* was not: `resolveTarget` throws, the throw reached the dispatcher's catch-all, and the agent read `kiln guard failed: refusing to follow a symlink` followed by **"This is a bug in kiln, not in your change. Run `kiln doctor`"**. Both sentences are false — it is the design, and doctor then prints `Ready.` because it checks a project's setup and knows nothing about one path. That is D7 item 3's shape turned on the error path, and **a message naming a remedy that does not exist** is the defect this project has now met four times. The cost is not the wording: editing a README is an ordinary request, zod is not an unusual repository, and an agent told the tool is broken either stops or routes around the block. The refusal now names the file the symlink points at, which is a remedy that exists; a dangling symlink says so instead of naming a file that is not there. The general rule the catch-all keeps: it is for a bug, and anything kiln decided on purpose is caught where the decision was made. | 09-23 |
| **D104** | **An update that cannot reach the project says so at the start of the next run** | D39 makes `/plugin update kiln` replace the plugin and write nothing into a project, which is right and is also why a checkout that already had the push floor keeps the hook the *older* kiln wrote. D105's `stale` state reports it — to whoever runs `kiln doctor`, which nobody does on a Tuesday. The one instruction kiln gave about updating read *"`/plugin update kiln`. That is all"*, and it was not all. Measured on a real monorepo after rc.19: five checkouts all `stale`, having run the whole of rc.18 carrying the submodule bug rc.19 had fixed, with every run printing `Ready.` So `kiln open` reports an unarmed floor once per run — at the moment the run's safety is being established, at two git calls per checkout rather than one per tool call. It **warns rather than blocks**: an absent floor is exactly what D54 calls a thing nothing at runtime can notice, and refusing to start work over it would be kiln policing its own upgrade. The docs now say `/plugin update kiln`, **then `kiln doctor`**. | 09-23 |
| **D105** | **A write to one branch is never judged against a candidate set** | Reported from a real monorepo run: a module standing on `feature/v3/#1864` ran `git merge origin/v3-master` and kiln refused it as a write to `v3-master` — the merge's **source**. The superproject sat on `v3-master`, the directory was not readable from the command text, and `branchesFor` fell back to every checkout's branch. The user merged the commit SHA instead, which is what a false block always buys, and D90's own comment already says why it matters: *false blocks are what teach an agent to route around*. The distinction that was missing is between two kinds of unknown. A `push` names its destination in a refspec that can reach any ref on the remote, so when the checkout is unknown every checkout's branch is a genuine **candidate** and blocking on any of them is a sound over-approximation — D33's direction when it cannot tell. `merge`, `commit`, `rebase`, `reset`, `revert` and `cherry-pick` write to **exactly one** branch: the one HEAD is on, in the one repository the command runs in. "Every checkout" is not a superset of that, it is a different set, and on a monorepo whose superproject sits on the integration branch it made every unplaceable `git commit` a false block. So `branchesFor` reports `resolved`, and an unresolved directory yields no target for a one-branch write. The scope check that settles it: **D7 item 1 is "never *pushes* to a protected branch"** — the README says push, the floor is `pre-push`, and the push half is untouched. Prior art agrees on where this belongs: pre-commit's `no-commit-to-branch`, the most deployed implementation of "do not commit to main", is a git hook reading the branch from git at commit time, never a scan of command text. **A ceiling named rather than built:** git's `pre-merge-commit` exists (2.24+) but is **not invoked on a fast-forward merge**, because no merge commit is created — so a hook floor for merge has a hole exactly where `git merge origin/<branch>` usually lands, and `pre-commit` would be a second hook family with its own install matrix. Neither is built at v1. | 09-23 |
| **D106** | **Scratch space exists where D19 said it did, and a refusal names somewhere to go** | Reported as "the sandbox blocked writing to the session scratchpad". Measuring it found the larger half: there was nowhere else either. D19's allowed writes were *project source, `.kiln/work/<active-id>/`, `.kiln/tmp/<active-id>/`* — and the third was never implemented, so scratch was judged as source and needed the plan gate. An agent investigating a ticket, before any gate exists, which is the whole point of investigating, had **no writable path anywhere**: the harness's scratchpad is outside the project, the repository needs a gate, and `.kiln/tmp/` needed the same gate. The same shape as the rules router — a promise in this log with no code behind it. `.kiln/tmp/<active-id>/` is now writable before any gate, with no extension filter (scratch is scratch) and scoped to the active work, because another run's step logs are its evidence; the sandbox's cross-work rule extends to the tmp tree for the reason it already covers `work/`. **The boundary does not move for the harness scratchpad:** kiln is handed a command, not the harness's configuration, and matching `/tmp/claude-*` would be the guessing this project refuses. What moves is the message, which now names a path that exists — a block naming nowhere to go is the shape that makes an agent invent one, and it is the fourth time this log has met it. One message was also untrue: a file directly in `.kiln/tmp/` was refused as "another work's directory" when it belongs to no work. This does not widen B25: an agent wanting to run a program kiln cannot read never needed a file, `bash -c` was always there. | 09-23 |
| **D107** | **kiln has a written grant over `tps-project-dna`, and it removes the blocker without changing the argument** | Asked before any DNA work began, because §1 measured that code as inherited evidence and never asked who owns it. Measured: the source is `gitlab.tpssoft.com/ai-champion/discovery/claude_skill`, owner *AI Champion - Discovery*, and a grep of the whole marketplace finds **no LICENSE file, no SPDX header and no grant of any kind** — so the default is all rights reserved, and kiln is a public MIT repository. That is a legal question, not a technical one, and D79 had deferred DNA for the wrong reason: the install dependency, not the provenance. The project owner, who works on that team, grants kiln full use and copying on 2026-09-23. What the grant changes: the store contract, the ERD, the id schemes and the two playbooks may be used **verbatim** as kiln's own specification, with the grant and its scope recorded in `NOTICE` the way D69 records the superpowers fork — a public repository's provenance record is what makes a grant checkable by a stranger later. What the grant does **not** change is the engineering argument, which never rested on the licence. **(1)** D2 and D6: shipping DNA as Python asks a stranger for Python 3.11+, and that was D79's actual reason for v1.2 — a reason a Node implementation deletes rather than defers. **(2)** Of 5,601 Python lines, `bootstrap_dd_sources.py` is 2,495 — **45%** — and it is an extractor for Vue, Spring and Odoo, which are not stacks kiln ships; D61 already has the extension point for that, a stack file. **(3)** D69's cost applies with nothing to offset it: a vendored copy of an internal plugin has no upstream releases to read, which is the one compensation the superpowers fork has. So Knowledge tier 1 is **built in Node from their validated contract**, not vendored — the grant is what makes using the contract free, and the contract is the part that was proven on two real projects (8.4k and 26.5k findings). The v1.2 label was tied to the dependency this removes; where the work actually lands is decided when it is scoped, not here. | 09-23 |
| **D108** | **A rule is added by a verb, add-only — the same answer D48 gave, arriving where D102 created the same problem** | D48's reasoning was that config holds the terms the run is judged by, so the agent may not write it, so `kiln config set` exists — *"a user who said 'the integration branch is v3-master' was told to edit JSON by hand. That happened three times."* D102 put project rules in exactly that position and left nothing on the other side: the answer given was *edit the markdown table yourself*. That answer was defended here with D13, which is the wrong axis and **D79 has already recorded it as the wrong axis** — D13 decides whether something must be code, not whether it deserves a command. The owner caught it. Prior art is unanimous and it is about the **authoring** step, not the matching step: Cursor ships `New Cursor Rule` so nobody hand-writes frontmatter, and `/Generate Cursor Rules` so the agent can write one from a conversation — and Cursor's most-reported rules failure is a malformed file skipped in silence, which is the authoring step breaking. `pre-commit sample-config`, `npm init @eslint/config`, `git config` and Claude Code's `#` are the same move. So `kiln rules add <file>.md --trigger "<glob>" [--text "…"]` writes the file and the row **together**, refuses a name that is not one `.md` inside `.kiln/rules/`, refuses a glob matching nothing git lists — the dead route doctor reports as a warning, raised to a refusal at the moment it is one edit to fix — and appends inside the table rather than after the prose below it, because a row past the table is not in the table and `readRoutes` would read it as no route at all. **Add-only** is the invariant that keeps D102 intact: a run may capture a decision as a rule, and may not rewrite or remove one. Adding is visible in the diff and lands in a committed file; weakening is not reachable. The exposure stated rather than hidden: an added rule can contradict an existing one, which is the same exposure `kiln config set` carries for re-aiming enforcement, and the same mitigation — it is recorded, and it is in the diff. | 09-23 |
| **D109** | **D20's three questions are asked where the rule is written, and the reason D20 dropped is restored** | The owner pointed at the source: the rule-budget gate this project inherited lives in the `claude_skill` marketplace README, under *Rule budget*, and reads *"Trước khi merge bất kỳ rule mới nào, trả lời đủ 3 câu"* — **(1)** can it merge into an existing rule, *prefer editing the old file over creating a new one*; **(2)** can an equivalent passage be deleted, so total volume stays flat rather than growing once per incident; **(3)** is it routed, because an unrouted rule is dead weight. D20 carried the three questions and mechanized two, and **dropped the sentence that makes them worth obeying**: *every rule line is a token the agent pays on every later ticket, and the longer the rules get the lower the model's — especially a small model's — compliance with each one, so adding a rule to force compliance can backfire.* Keeping the goal and losing the reason is why a budget reads as bureaucracy: *total volume stays flat* persuades nobody to shorten a rule, *more rules means less obedience per rule* does. Cursor's users report the same finding from the other side — past roughly ten always-on rules the model partially violates most of them — which makes it two independent measurements of one effect. D108's verb had walked past all three: it wrote a rule without asking whether one already covered those files, which is the exposure D108 itself named as *stated rather than hidden*. Question 1 is judgment and stays judgment, but judgment needs its material, and the material is computable: `kiln rules add` now names **which existing rules already cover the files this trigger covers, and how many**, prints the line count **before → after** against `rules.budget_lines`, and confirms the routing it just wrote. The baseline that set kiln's default is the same corpus: unioss's router is **176 lines across 10 files**, and `budget_lines` is 200. | 09-23 |
| **D110** | **A reserved word is read from the first word, because `rules` is a word a user types and it takes arguments** | Measured the moment the owner asked whether the command could be called from the CLI: `/kiln:kiln rules add controllers.md` resolved as a **description** and minted the work id `20260923-rules-add-controllers-md`, then began investigating it. The most natural attempt at a command, answered by silently doing something else — and `work/rules/` could then shadow the verb, which is the exact failure D79 reserved `dna` to prevent. D79's law was right and its implementation was an exact match, because `init` and `doctor` take no arguments and `rules` does. So the check reads the first word and hands the remainder to the command as `rest`. **The trade is taken deliberately:** a sentence opening with a reserved word — *"rules for the export page are wrong"* — is now refused rather than run. That is the cheaper of the two errors, and D33's direction applied to the argument rather than to a guard: a refusal is visible and one rephrase away, while minting a junk work and investigating it is silent, expensive, and leaves a directory behind. The slash command is not, however, how a rule should be added. D24's surface is three things a user types and the primary one is a **sentence**, so the designed path is the one D108's prior art already pointed at — Cursor's `/Generate Cursor Rules`, where the agent writes the rule from the conversation. The orchestrator now takes *"controllers must never contain SQL"*, writes the text, chooses the glob, calls `kiln rules add`, and reads D109's three questions back. Reserving the word is what stops the other path from being a trap; it is not what makes it the path. | 09-23 |
| **D111** | **A submodule's files are not invisible to a check about the project** | Found on the owner's validation run, by the agent rather than by any test. A rule routed to `**/application/controllers/**` was reported by `kiln doctor` as *"matches no file here, so no-sql-in-controllers.md reaches no stage"* — and the rule fires perfectly well. `git ls-files` at a superproject lists a submodule as **one gitlink entry**: measured on that repository, `AdminPage` rather than its 71 controllers, and 0 paths containing `application/controllers` against 100 once every checkout is asked. So D110's dead-route check was blind to exactly the code kiln was installed to guard, and on that project the warning would have stood for **every rule anyone ever wrote** — a warning that is always wrong is a warning people stop reading, which is D89's own finding arriving at a second instrument. The half that had not shipped yet is worse: D108's `kiln rules add` **refuses** a glob matching nothing git lists, so the very rule the owner needed would have been refused outright on the next release. `kiln rules` itself was never wrong, because it matches the paths a stage names and those come from `actualChanged`, which already walks submodules — the inconsistency was between two halves of one feature, one asking git properly and one not. `trackedUnder(root)` asks every checkout `checkoutsUnder` finds and prefixes each path by the checkout's position, which is the shape a stage names. **Third time this answer has been the fix** — D90 for the push floor, D100 for the worktree hook dir, here for the file list — and the standing lesson is now specific enough to write as a rule of thumb: a question about *the project* is a question about every checkout, and only a question about *this command* is about one. | 09-23 |
| **D112** | **Asking for the same rule twice is not an error, and an agent routing around a verb is the same failure as one routing around a guard** | Measured on the owner's second validation run. They asked for the same rule again; the agent read the file itself, reported that it already existed, and **skipped the verb** — which was the right move, because the verb would have refused. D108 made `already routed` a non-error precisely so a repeat call would be a no-op, and then left the other half refusing: the natural call carries `--text`, and any `--text` against an existing file was refused outright. So the idempotent path existed only for a call nobody makes. The fix is the text, not the flag: content identical to what is already there is *nothing to write* and the command continues to the three questions; content that differs is still refused, because add-only is what keeps D102 intact and rewriting a rule is exactly what a run must not do. The refusal now says **which** of the two happened, so it cannot be read as spurious. The general shape is worth naming because it is the third relative of the same defect: a **false block teaches an agent to route around a guard** (D93, D105), and a **verb that errors on a reasonable call teaches it to route around the verb**. The instrument does not have to be a guard for the lesson to apply — anything the agent is told to call, that refuses something reasonable, gets replaced by improvisation, and improvisation is what the whole design exists to remove. The orchestrator is now told to call it even when the rule looks present, because the questions are the point and a no-op still asks them. | 09-23 |
| **D113** | **The recommendation rides on the option it recommends, and the line above says what finished** | Every gate opened with `Recommendation: approve. <why>` above a numbered menu. Two things were wrong with it. It put kiln's preference **above the evidence**, in the position a finding belongs, where it reads as pressure rather than as a conclusion the user is free to reject — and it argued in one place while the decision was made in another, two lines down, which is the shape D25 already rejected for todos. The replacement is the idiom the harness itself uses: the line states what finished (`Plan complete — <why>`), and the preference is a `(recommended)` suffix on exactly one option. Evidence it is the right idiom rather than a taste: the owner's own transcripts render Claude Code's question UI as `→ php-ci3 (Recommended)` several times in the same session a kiln gate was arguing above its menu, so a run was switching idioms inside one transcript. **One mark or none** — a menu that recommends two options recommends nothing. The blocking-unknown clause moves with it: the line above says the unknown stands in the way instead of arguing for approval, and answering it becomes option 1 and carries the mark, because a gate that recommends approval over an unanswered question asks for a decision nobody can make. The load-bearing half was checked rather than assumed: a format change that quietly stopped a gate recording approvals would be the most expensive kind, so `1. Approve this plan as written (recommended)` is classified in a test — the suffix survives `openingClause`, the verdict still reads `approved`, and a bare `1` still says nothing (D21). | 09-23 |
| **D114** | **The plan stage names its own files, because the approved claim does not exist yet** | The worst defect of this cycle, and it hid behind green tests. D101's plan half read `state.predicted` — and D31 writes `predicted[]` at the **gate**, deliberately, because it is the *approved* preview and D72 registers cross-work claims from it. So the router was reading a field that is empty until after the gate it exists to inform, and **every real run got "The plan names no files yet"**. Six pull requests, a decision entry and a test suite, and the PLAN half had never once worked outside a fixture. It hid because the tests wrote `predicted` straight into `state.json` — exercising a state the product has no way to reach at that point in a run, which is a test asserting its own fiction. The rule now reaches the plan through `--predicted`, passed by the caller: the agent wrote the plan, so it knows which files the preview names, and handing them to the router is a **read** while handing the same list to the gate is the **claim**. `state.predicted` stays the fallback, correct once the gate has written it. Measured on the owner's run, where the agent diagnosed the cause itself — *"It only reads the predicted file list, and that list is empty until the gate is recorded. I matched the rules myself instead"* — and then routed around the verb, which is D112 a third time and the clearest evidence yet that the pattern is real: an instrument that answers uselessly gets replaced by improvisation, and improvisation is what the design exists to remove. The empty answer now names the flag instead of describing the emptiness. | 09-23 |
| **D115** | **The review gate asks whether the rules were read, and asks only where a rule is routed** | Two runs reached REVIEW on the same project. The first called `kiln rules --stage review`; the second did not, and **nothing noticed** — a coin flip on the one claim D101 makes that nothing else covers: a rule reaching a file *the plan never predicted*, which is the case a router seeing only what is already in context cannot reach and the case where runs go wrong. The instruction was there and was prose, and D20's evidence on prose is measured rather than argued: the repository that authored the rule-budget law violated it 28 times because it was prose and not a gate. So the gate asks. **Two narrowings keep it from becoming the thing it is guarding against.** It asks at **review only** — PLAN's call shapes a document the user is about to read, and a plan that ignored a rule is visible in the gate, while REVIEW's is the last moment anything looks at the files the run actually touched. And it asks **only where a rule is routed**: a project that has written none has nothing to read, and a precondition that buys nothing is friction the next person routes around, which is D112's whole finding. Where a rule is routed the question is whether the router **ran**, never whether anything matched — `files: []` is the record of having asked, and it was built for exactly this. Four journey tests failed on the first attempt, before the second narrowing; that was the design being told it was too wide, and it is recorded because the failing tests were the evidence, not an obstacle. | 09-23 |
| **D116** | **A branch created earlier in the same chain is the branch the later command writes to** | Measured at the **ship step** of the first run to reach a commit. The agent wrote `git checkout -b feature/v3/<id> && git commit -m "…"`, and kiln refused the commit as a write to `v3-master` — because the guard asks git which branch HEAD is on *before any of it runs*, and the commit lands on the branch the first half creates. The agent split the command in two to get past it, which is D112's shape at the last step of every run: a false block, an improvised way around, and no record that either happened. D105 fixed the half where kiln knew too little about **which repository**; this is the half where it knew too little about **when**. The fix is the reading `cwdChain` already does for `cd`, with one difference that is the whole of its soundness: the branch carries **only across `&&`**. With `&&` a failed `checkout -b` stops the chain, so the later command runs only if the branch was created; with `;` it runs anyway, on the old branch; `||` runs it *because* the checkout failed. `splitWithOperators` therefore reports the raw operator as well as `sequential` — the two questions are genuinely different, and a `cd` survives a `;` while a branch creation does not. Only the **creating** forms count (`-b`, `-B`, `-c`, `-C`, `--create`): `git checkout <existing>` moves to a branch that may well be protected, and that case must keep blocking. And the created name is compared against `vcs.protected` like any other, because resolving to a name is not trusting it — `git checkout -b v3-master && git commit` is still refused. | 09-23 |
| **D117** | **A work that shipped stops claiming, and `reviewed`/`shipped` get a writer** | `STATUS.reviewed` and `STATUS.shipped` were **read** by `resolve.mjs` — D24's resume table branches on both — and written by nothing. So every work stayed `in_progress` for ever, and with it the claim its `predicted[]` holds: `claimOwner` checks only **active** works, so a file touched once was claimed permanently and the next work touching it halted at its plan gate naming a run that had finished days ago. D72's conflict is right; firing it on a finished work is not, and the false block grows with the age of the project. Found while writing instructions for three runs of one ticket — runs two and three would have halted against run one — which is the same lesson as D111 and D114 from a third direction: a state nothing writes is as broken as a value nothing reads, and both hide until somebody tries the sequence end to end. **`reviewed`** is the path's own ship-authorising gate being approved: `review` on bounded, where accept is accept-and-ship, and `ship` on full. A spike has neither, and correctly never reaches it — it also claims nothing, having no plan gate to claim with. **`shipped`** needs an act kiln cannot observe: the agent opens the pull requests with its own `gh`/`glab`, so `kiln ship <id> --opened <url,url>` records what came back, and printing a plan stays what it always was — a plan, not evidence. The urls also give tier D's fourth line something to measure: *human edits after accept* was recorded as unmeasurable because no run had reached a pull request. | 09-23 |
| **D118** | **Auto mode says what it ruled at the moment it rules it, because a block nothing calls is the black box it was written to prevent** | D16 made the `Auto-ruled` block mandatory and gave the reason in its own words: *without that block auto mode is a black box, and a black box is not trusted twice.* B58 makes its absence a test failure. Both were satisfied on paper. `renderAutoRuled` was correct, two B58 tests proved it renders — and the **only** way to reach it was `kiln report`, a command nothing requires. Measured on the owner's first auto run: two gates recorded `by: "auto"`, and the closing account mentioned it in half a sentence the agent wrote itself. A renderer nobody calls is the same black box with a test beside it, and those two B58 tests are the clearest instance yet of what D114 named — a test proving the mechanism works without ever proving anybody sees it. So the printing moves onto the path that has to happen anyway: **one line per ruling, as it happens**, because a summary at the end is read after the decisions it describes; and the **whole block once, at the gate that authorises shipping** (`SHIP_AUTHORIZING[path]`), the last gate any path records. stderr, because stdout there is JSON the caller parses. No new command and no new refusal — the gate call already had to happen, and it is where the fact is known. | 09-23 |
| **D119** | **A sentence about a consequence that is already false travels further than a wrong remedy** | D117 gave `reviewed` and `shipped` a writer and described `--opened` as the thing that *"stops claiming the files it predicted"*. Half of that is true — it writes `shipped` — and the other half is **one step late**: `activeWorks` is `in_progress` or `halted`, so the claim is released the moment the review gate makes the work `reviewed`, before any URL exists. Measured on the owner's auto run: the agent read the help, believed it, and told them **twice in the closing summary** that a finished work was still holding a file it had already let go, with instructions for a problem they did not have. This is the fourth relative of *a message naming a remedy that does not exist*, and the most dangerous of them, because a wrong remedy is discovered when somebody tries it while a wrong **consequence** is repeated by the agent in its own words, where nothing checks it and the user has no reason to doubt it. The line now says what `--opened` is for — the record of what exists, and the `shipped` status that lets a second pass open — and a test pins the release point in both directions: blocked while `in_progress`, allowed once `reviewed`, with no URL recorded either time. | 09-23 |
| **D120** | **A submodule committed ahead of its superproject names no files** | Two shapes were already handled: a dirty submodule (its own `git status`) and a gitlink the superproject has committed (`diff --raw`, then a diff one level down). The third is the state **every** run on a submodule project ends in — the commit landed inside `AdminPage`, and the superproject has not bumped the gitlink. The submodule's status is then clean, so the first path fell back to the bare gitlink; the superproject's commit range does not contain the bump, so the second never fired. Measured on the owner's auto run: reconciliation reported `beyond: AdminPage`, and `kiln rules --stage review` matched its globs against `AdminPage` and routed **nothing** — so "controllers must not contain SQL", the rule the whole ticket existed to satisfy, was never handed to the review that would have checked it, and the agent checked it by hand instead. A router that silently routes nothing is D89's finding again: an instrument that is always wrong is one nobody reads. The superproject's index still holds the SHA it believes in, so `git rev-parse :<path>` and one diff inside answer it — the fourth time the answer has been *ask git about every checkout, not the one you are standing in*. | 09-23 |
| **D121** | **A fact stated in two places is fixed in two places** | D119 corrected `--opened`'s CLI help, which had said it *"stops claiming the files it predicted"*. The orchestrator skill carried the same sentence — *"A work that does not say it shipped goes on claiming the files it predicted"* — and the skill is the copy the agent **actually reads**: the CLI help is printed only when someone asks for it, the skill is loaded on every run. So the next run repeated the false consequence to the user anyway, one day after the fix, and the fix looked like it had worked because the help was right. A correction that does not ask *where else is this said* is half a correction. `tests/skills.test.mjs` now refuses the sentence in any skill, which is the only form of the fix that survives the next edit. | 09-23 |
| **D122** | **A guard that fires when nothing is being guarded is a false block** | D33 says kiln does not police a session it is not driving, and `sourceEditVerdict` honours it — no state, no verdict. `sandboxVerdict` never did: its project-root boundary fired whether or not a work was open. Reported by the owner from a different project: one `kiln init` in `marketplace-ui`, no work open, and from then on **every** Claude Code session there was refused a write to `~/.claude.json` — with `.kiln/tmp/<work-id>/` offered as the place to put it instead, a remedy addressed to a work id that did not exist. The user's own reading was the right one: *"has this hook blocked unrelated tasks in other sessions"* — yes, and the block was kiln's bug, not their edit. The boundary keeps its whole force while a run is open, which is what it is for: an agent kiln is driving stays inside the project. Outside a run there is no run to keep anything inside of. What still holds with nothing open is what does not depend on a run at all — kiln's own control files, and the push floor in `.git/hooks`, which exists precisely so D7 item 1 survives a session kiln is not in. | 09-23 |
| **D123** | **A stack kiln never detected is not a stack kiln cannot serve** | `init` writes `stack.id: "unknown"` when detection recognises nothing — D92's ask-the-user, not a guess — and there is no `stacks/unknown.json` and no intention of one. The hook looked it up anyway: `loadStack` threw, the throw reached `main()`'s catch-all, and **every edit in the project** came back *"This is a bug in kiln, not in your change. Run `kiln doctor`"*, while doctor named the config line correctly. Any project outside the two shipped stacks met that on its first edit after `init`, with nothing open and nothing wrong. Found while reproducing D122 on a bare Python repository. Two situations were being treated as one: the sentinel now contributes no guards, and a stack **named** and missing still blocks — that one is the project's own guards silently not running, which D33 refuses to fail open on — with a message naming `stack.id` instead of blaming kiln. | 09-23 |
| **D124** | **A promise kiln makes in a message is kiln's to keep** | Every sandbox refusal ends with *"A temp file goes in `.kiln/tmp/<id>/` — inside the project, gitignored, and removed at the end of SHIP"*, and the orchestrator says the same. Nothing removed it. Worse, the run could not remove it either: a work leaves `activeWorks` at the **review gate**, so one step before the run ends the session stops owning its own scratch tree, and the refusal it then met — *"a work directory, and this session has no work open — run `kiln open` first"* — asked the agent to start a run in order to tidy up after one. Measured on the owner's run, which ended reporting a leftover folder it had been blocked from deleting. Both halves are kiln's: `ship --opened` now removes the tree, which is the sentence the message was already making; and with nothing open, `.kiln/tmp/` is no longer policed at all — `work/` is the run's evidence and stays kiln's either way, but scratch with no run is leftovers. | 09-23 |

#### Pre-v1.0 audit entries (2026-09-23, design read against the product and against OSS)

An audit read this file against the code, then had every finding re-run by an adversarial
pass and weighed against how mature open-source projects solve the same problem —
superpowers, BMAD and agent-skills for the workflow, and the two most-used Claude Code guard
hooks, cc-safety-net and destructive_command_guard (dcg), for the guards. A 142-row corpus run
through the real dispatcher found 33 wrong verdicts. The owner ruled four questions (D136,
D137, D142, D146) and set the standing rule these entries follow: **where a mature OSS project
has a better approach, it is the one adopted, and a fix is general across projects or it is
not a fix.**

| # | Decision | Rationale | Date |
|---|---|---|---|
| **D125** | **The guards are tested through the production entry point, as a labelled corpus, and a verdict is asserted with its reason** | A unit test had built its own `repoFor` without the dispatcher's `?? ctx.cwd`, so it proved the opposite of what production did (D132). cc-safety-net spawns its built CLI with JSON on stdin and asserts the reason constant; dcg keeps `true_positives / false_positives / bypass_attempts` corpora. kiln adopts the shape — `tests/corpus.test.mjs`, must-deny, must-allow and `ceiling` rows, every deny checked against its message and against "bug in kiln". Neither tool's cases are reused: both **allow** `git push origin main`, which kiln must refuse, and dcg's licence carries a rider excluding use by or for Anthropic, benchmarking included. No standard benchmark measures a guard (the academic suites measure a model's propensity to do harm), so this corpus is the instrument, and "never" is stated as what it is: zero misses in *n* rows bounds the rate near 3/*n*, not at zero. | 09-23 |
| **D126** | **A heredoc body is data, and the commands after its terminator are commands** | The earlier fix cut every command at its first `<<`. That hid everything after the body: `cat > ok <<EOF … EOF` then `echo x > /elsewhere` was allowed, and so was a `git push origin main` on the next line. The lexer now removes exactly the body — a command substitution opens a fresh quoting context, which is what makes `git commit -m "$(cat <<'EOF' … )"` a real heredoc — and one quote-aware split with operators serves every guard, so the protected-branch scan stopped reading `git commit` out of a note being written to a file. A body whose terminator never arrives is judged as written rather than guessed at. Still lexical (D34, D93): quotes and heredocs are what the shell settles before anything runs. | 09-23 |
| **D127** | **Moving a control file away, or anything that holds one, is removing it** | `mv .kiln/work/<id>/state.json old.md` was allowed — only a `mv` *destination* was checked — and the next source edit found no gate record to hold it to. cc-safety-net guards its policy file against a `mv` whose source is the file, its directory, or an ancestor; kiln adopts that rule for `config.json`, every `state.json`, `.kiln/hooks/` and `.git/hooks/`, across `rm`, `mv`, `git mv`, and `chmod`/`chown`/`chattr` (a work directory made unreadable used to vanish from the guard's view). A symlink is removed as the link, never resolved through, so `rm link.md` is no longer reported as a bug in kiln. | 09-23 |
| **D128** | **`rm` is read as tokens, `-r` alone is recursive, and `~` and `$HOME` are expanded** | A regex over lowercase short flags missed `rm -Rf` and `rm --recursive --force`. cc-safety-net's `rm-flags` reads `-r`/`-R` in any cluster and long-option prefixes; dcg refuses a recursive remove without `-f`, because `-f` only silences prompts. `rm -rf ~/data` — the example D34 was written for — resolved as a directory named `~` inside the project and was allowed. Every other variable stays unread: the ceiling. D34's scope is unchanged: outside the project root, during a run. | 09-23 |
| **D129** | **An inline program is any program the interpreter reads from its arguments or stdin, and its body is searched too** | D98 knew `-c`, `-e`, `-r`; `node -p`, `node --eval` and `python3 - <<EOF` named `.kiln/config.json` and ran. dcg #425 is the same bug. The flag list is replaced by the question: does the interpreter get a script file (the ceiling SECURITY.md names) or a program inline — a flag, `-`, a pipe, a heredoc. Only a word in command position is an interpreter, so `cat .kiln/config.json | grep node` stays a read. | 09-23 |
| **D130** | **The disarm guard reads git's option grammar: long-option prefixes, clustered short flags, and every config override** | `git push --no-verif` is `--no-verify` to git (gitcli(7): an unambiguous prefix) and got past a literal match; `git commit -nm x` skipped the hooks; `GIT_CONFIG_PARAMETERS` redirected `core.hooksPath`. Measured with a failing hook, each let the operation through, and the test claiming "git rejects the abbreviations" was false. Prefixes from `--no-v`, `-n` read from a cluster until a value-taking letter, `GIT_CONFIG_PARAMETERS`, and husky's and lefthook's own `=0` switches. A quoted commit message is not a flag. The division D90 drew holds: a finite, documented grammar is the easy half; the forge's branch protection is still the ceiling. | 09-23 |
| **D131** | **A branch the chain moves to is the branch a later command writes to, created or not** | D116 carried a *created* branch across `&&`. `git checkout main && git commit` moved to an existing one and was judged against the branch the session stood on — a commit on `main`, allowed. An existing branch carries across `&&` as the branch, and across `;` as one more candidate beside the current one; a created branch still carries nothing across `;`. | 09-23 |
| **D132** | **An unknown directory stays unknown** | The dispatcher passed `chain[index] ?? ctx.cwd`, turning `cwdChain`'s "cannot tell" into "here". A push from a submodule on a protected branch behind `cd $DIR &&` was allowed, and an unplaceable `git commit` was refused against the session's branch — both directions wrong. D105's candidate set and one-branch rule now receive the unknown they were written for; cc-safety-net likewise never falls back to the session cwd after an untracked `cd`. | 09-23 |
| **D133** | **Unreadable is not absent, at every layer — and the law is now checked** | Four branches ended in ALLOW on something kiln could not read: a config that exists but does not parse (no stack guards ran, so `DROP COLUMN` passed on php-ci3), a work directory returning EACCES, a stack guard exporting no `check` or rejecting asynchronously, and the push floor, which parsed its config inside the walk and so skipped a BOM'd or broken one. Each now blocks, naming the file; the floor also protects the branches the project ships from, as the guard does, and a stale runner is replaced by `doctor --write` and reported at `open`. `findRoot` treats a config it cannot read as present. The invariant D33 stated in 09-19 and never checked is a test: every `catch` in the guard layer throws, blocks, or carries a `fail-open:`/`fail-closed:` line saying why — cc-safety-net's architecture test is the model. Malformed hook stdin stays allowed, deliberately and asserted: it means the harness is broken, and dcg makes the same call. | 09-23 |
| **D134** | **The project root is compared as its real path** | Targets were resolved through symlinks and the root was not, so a project reached through a linked directory — macOS's `/tmp` is one — had every source edit refused as "outside the project root" while `.kiln/config.json` was not recognised as kiln's own. | 09-23 |
| **D135** | **Every checkout's hooks are verification files, and so is `.husky/`** | The floor is installed in every checkout (D90), and a submodule keeps its hooks and config under `.git/modules/<name>/`. Only the superproject's `.git/hooks` was protected. | 09-23 |
| **D136** | **A shipped work is never reopened; follow-up work is a new work that names the one it follows (supersedes D85 and D24's "opens pass N+1")** | `openNextPass` had no caller, so reopening a shipped work left pass 1's gates in place and — a shipped work being in no set the guards read — every guard off for the whole second pass. superpowers treats follow-up work as new work with its own approval ("they approved the spike, so the follow-up is approved too" is one of its red flags); BMAD ingests a done story as context for a new spec. So `resolve` answers `follow_up` with the next free `<id>.<n>`, `open` refuses a shipped id and names the command, and `--follows` records the link. `pass` stays in the schema at 1. Owner's ruling. | 09-23 |
| **D137** | **A reviewed work is still guarded, and a full VERIFY that fails after review sends it back to implementation** | D119 released the claim at the review gate, and with it the work left every set the guards read: between review and ship, source edits were ungated. Identity now covers `reviewed` while claims do not; source is refused with the reason, the work's own artifacts and scratch stay writable. A failed full run is the one legitimate reason to change reviewed code, so it reopens implementation, drops the review (and ship) approval, and records `verify_failed` — BMAD's code review returns a story to in-progress the same way. Owner's ruling. | 09-23 |
| **D138** | **`ship --opened` asks the same question `gh pr create` does** | On a work with no gate at all, `kiln ship <id> --opened <url>` set `shipped` and the guards stopped reading the work: the ship gate walked around through kiln's own verb. It now requires the path's ship-authorising gate, approved and still bound to its document; a spike is refused by the same table (D77). | 09-23 |
| **D139** | **A gate hashes the document its key names; an approval with no document binds to nothing (strengthens D71)** | `--artifact` was optional, and a record with `artifact_sha: null` bound forever — editing the plan after approval changed nothing. The document is now the key's (`probe` → `brief.md`, `spec`, `plan`, `review` and `ship` → `review.md`); a gate whose document is missing, or a different file named for it, is refused. superpowers #2258 binds approval to the plan by procedure and BMAD re-reads the spec from disk and halts if it is gone; the hash is stronger than both, now that it cannot be skipped. | 09-23 |
| **D140** | **REVIEW measures from the work's base; `last_verified` is provenance only (supersedes D67a's review anchor and D76's use of it)** | With commit-per-task and a full verify before review, `last_verified` moved to HEAD and REVIEW saw zero files, halting on "a commit on another branch". superpowers reviews from the branch point (merge-base) and BMAD from a baseline that never moves; neither anchors review on the last verification. D67a's concern — a week-old resume sweeping unrelated history — is D96's re-anchor, which already exists. | 09-23 |
| **D141** | **Evidence names the tree it ran against, and a stale green is said to be stale** | `verify[]` recorded a commit range; kiln commits nothing before SHIP, so edits after a green run left the range unchanged and `kiln report` still printed green. Each entry now carries the working tree's git tree id (tracked and untracked, `.kiln/` excluded, from a copy of the index that keeps its mtime so git's racy-clean check still re-reads a same-size edit), and `report` and `ship` say "was green, and the tree has changed since" when it has. `isStaleVerify`, written and never called, is what they call. superpowers re-runs the check at the claim point (`task-done`, finishing-a-branch); a record without a tree is stale by definition. | 09-23 |
| **D142** | **SHIP is the one commit point, and the forked skills say so** | The design never committed before SHIP (D36, D78) while the forked implement and writing-plans skills committed per task, as superpowers does. OSS is split: BMAD and agent-skills leave the tree uncommitted until the work is done. Owner's ruling: BMAD's. The skills drop the commit steps; rulings go to `.kiln/work/<id>/ledger.md`, the record the agent can actually write — the text had told it to write `carry_over[]`, which only kiln's verbs can. The reviewer diffs the working tree against the base, untracked files included. | 09-23 |
| **D143** | **The ratchet halts with D78's menu once anything is recorded; before that, choosing the path is classification** | The code switched the path and carried on, which decided by not asking. It now halts with `git diff --stat`, the untracked files, and a numbered menu, and the choice is recorded with `resume`. Before any gate or change there is nothing to launder, so the path may still move either way — the exception the code already made, recorded here so it no longer contradicts D87 by silence. | 09-23 |
| **D144** | **Reserved ids are refused where ids are made; a minted collision is refused; a ref two modules could own names both** | `kiln open dna` created `work/dna/` — the reserved check lived only in `resolve`. A sentence minting an existing id on the same day was offered as new work. D51's prefix took the first ticket-owning module for every ref, so both modules' `#42` shared one id; `resolve` now returns the candidates and the URL or the user supplies the module. | 09-23 |
| **D145** | **The knobs and repairs the design promised exist** | `work.committed: false` (D36) had no reader; it now ignores `.kiln/work/`. `doctor --write` repairs a module path `.gitmodules` answers (D39, unioss's `scan --write`) and rewrites an older schema, which every command now mentions in one line; a newer `state.json` is refused with both numbers, as a config is. Config writes are atomic, now that an unreadable config stops every write. | 09-23 |
| **D146** | **The visual companion runs in a kiln run (keeps D11)** | Its screens went to `.superpowers/brainstorm/` in the project — source until the plan gate, so every screen was refused — and it was launched by a path relative to the user's project. It now keeps its session under `.kiln/tmp/<id>/`, the one place a run may write before its first gate, and runs from `${CLAUDE_PLUGIN_ROOT}`. The forked brainstorming text is adapted to kiln's gates: a spike's probe and a bounded plan are approved at gates, not by a nod or in chat alone. Owner's ruling: fix, not drop. | 09-23 |
| **D147** | **`--auto` in the request satisfies `full`'s opt-in (amends D16's wording)** | D16 says `full` is "explicit opt-in only", and the code has treated the flag typed into the request as that opt-in since the flag existed, with the reason in a comment: the harness refuses an agent editing the config that governs its own gates, so the request is the only place a human can opt in during a run. Recorded here so the log says what the product does. | 09-23 |
| **D148** | **kiln judges only calls that touch a project it drives — found from every directory the call touches, not only the session's (amends D33's fallback row)** | Found by the acceptance run itself: with the plugin installed, a scratch repository that had never run `kiln init` could not `git push origin main`. With no config anywhere, the guard fell back to protecting `main` and `master`, so installing kiln changed the rules of every repository on the machine — the false block D122 names, one layer over. No config in reach is D33's proven branch: kiln is not driving this. The other half is what keeps that from being a way around: the session's cwd is not the only place a call can land. The file an edit names, the directories `cd` and `-C` move to, and the paths a command writes or removes are all asked; the first under a `.kiln/config.json` is the project, judged by its own config. That also closed an older hole — an edit to `/proj/.kiln/config.json` from a session standing elsewhere was compared against the wrong root and allowed. The hardcoded list survives for the case D33 wrote it for: a project whose config is there and cannot be read. | 09-23 |


### Superseded

- ~~D85 and D24's "a shipped work opens pass N+1"~~ → superseded by **D136**. The pass
  machinery was specified and never reached by any command, so pass 2 ran with pass 1's gates and
  every guard off. Follow-up work is a new work that names the one it follows.
- ~~D67a / D76's REVIEW anchor on `last_verified`~~ → superseded by **D140**. REVIEW measures from
  `base`; `last_verified` records the last green full run and nothing reads it as a range.
- ~~D26's "vendored code lives under `vendor/`" and "shellcheck joins CI only if kiln writes its
  own bash"~~ → the companion lives in `skills/kiln-brainstorming/scripts/` and is the only
  lint-excluded tree; kiln writes its own bash since D90 (`lib/floor/pre-push.sh`), so shellcheck
  runs in CI over every shell script, which is D26's own condition met.
- ~~D98's inline-program flags `-c`, `-e`, `-r`~~ → widened by **D129** to the question the flags
  stood for.

- ~~Section 2 "Port contracts" (5 code ports)~~ → retracted 2026-09-19 by D13. Tracker, VCS and Verify are **not code ports**; they are a config line plus skill instructions telling the agent which of its own tools to use. Only **Stack** (its `steps[]` must execute deterministically and its `guards[]` must run inside hooks) and **Knowledge** (grep / DNA are real code) remain code ports. 5 → 2.
- ~~"`description` ≤ 200 chars, hard cap"~~ → **wrong measure, corrected 2026-09-19.** The validated OSS run 200–455 chars (superpowers `brainstorming` ~200; agent-skills `browser-testing-with-devtools` ~325, `interview-me` ~455). A 200-char cap would force dropping the `"Use when…"` trigger clauses that make routing work. claude_skill's disease was not *length* but **changelog occupying the routing-signal slot** (`tps-quantification-intake`: 20,902 chars). Replaced by: per-description **≤ 500 chars as a warning**; a **content-kind check** that rejects a description containing a version string (`v\d+\.\d+`) or changelog verbs; and the **aggregate always-on cap (≤ 6,000 chars) as the real budget**. Check the kind, not the length — the length check punishes the healthy.
- ~~D15 "DNA refresh has two triggers; write path after SHIP"~~ → superseded by **D22**. The post-ship write would record unmerged code as fact.
- ~~`round-N/` folders + `guard-rounds`~~ → superseded by **D18/D19**.
- ~~Stage `SCOPE`~~ → superseded by **D23**. 8 stages → 7.
- ~~`tmp/<id>/` is deleted when review is clean (D18)~~ → corrected by **D28/D29**. Full verification runs *after* the review gate, so its step logs would be written into a directory already deleted. **Deletion moves to the end of SHIP**, which is also the real end-of-life: before SHIP the work is not finished, and a failed VERIFY sends the run back to IMPLEMENT. D18's other claims stand.
- ~~D66's displaced-session block, read as implemented because it was specified~~ → it was not. Acceptance run C6 found the hole D66 itself names still open: `workForSession` finds no match for a displaced session, "no match" means kiln is not driving, and "not driving" means allow — so the first session kept working with its guards silently off. Ownership could not cover it, because a path discovered during implementation is in no `predicted[]` **by design** (D31). `kiln open` on an existing work is now a handover that says so, records the session it replaced, and blocks that session's next source edit.
- ~~D40 read as "the stack file holds the steps"~~ → corrected by **D86**. Its own title says `init` adds a step when it detects one.
- ~~D24's *"opens pass N+1 after confirmation"*, silent on what happens to `gates`~~ → answered by **D85**. Pass 2 inheriting pass 1's approvals turns off D7 item 4 and D77's ship gate together.
- ~~D65's artifact-hash rule, written only about the gate that authorizes source edits~~ → extended by **D85** to every gate key. It also does not reach the pass boundary at all, where an **unchanged** artifact is the failure rather than the proof.
- ~~D59's narrowing of D7 item 6 to *"kiln's own code performs no network egress"*, full stop~~ → qualified by **D83**, found in the final pass. D59 dropped the original *"outside the declared tracker/VCS"* and D82 then made kiln's own code run `git fetch` — so the narrowed claim was false from the moment the drift check was specified. Item 6 now names the two git verbs it permits against the configured remote.
- ~~§3e's dispatch chain, `pre-bash : guard-protected-branch → guard-sandbox(bash)`~~ → corrected 2026-09-20 in the final pass. It had been stale since **D64**, which put shell write verbs under `guard-gate`, and **D77** made it wrong a second way: `guard-gate` registered on `pre-edit` alone enforces neither the Bash write verbs nor the PR verbs. Same class as H1–H5 — stale text inside a LOCKED section, found by reading the diagram against the decisions instead of against itself.
- ~~§3c's *"ship is blocked separately (D12)"*~~ → given a mechanism by **D77**. It named no mechanism because there was none, and checking it found the same hole on the `full` path, where the `ship` gate was prompt-only.
- ~~`vcs.integration_branch` as a single scalar~~ → corrected by **D81**. `source_pins` is a map keyed by repo; one scalar is right for at most one module of a multi-repo checkout and silently wrong for the rest.
- ~~D24's *"final surface: `init` · `<arg>` · `doctor`"* read as permanent~~ → holds for **v1**; **D79** adds `/kiln dna` at **v1.2**, alongside the tier it serves. The rule D24 actually set — a command that duplicates what state already answers is not a command — is untouched, because `dna` duplicates nothing.
- ~~"Refresh and view DNA are skill text, not commands" (proposed earlier in the fifth pass)~~ → reversed by **D79** before it was written. D13 decides whether something must be **code**; it does not decide whether something deserves a **command**. The deciding rule is D6: a stranger cannot discover skill text.
- ~~D22 read as also defining which branch the **scan** runs on~~ → it did not; **D80** defines it. An unpinned scan side re-enters the bug D22 fixed on the comparison side.
- ~~"Four inherited skills, vendored as copies **pinned** to upstream v6.4.1" (D4 → D55, D62)~~ → superseded by **D69**. Measured from the v6.4.1 sources rather than its release notes: the four do not close — `executing-plans` alone hard-requires six skills kiln does not ship, two of them as REQUIRED SUB-SKILL, one of them the worktree D66 forbids, plus a second state store (`.superpowers/sdd/<plan-basename>/progress.md`) beside `state.json`. A pin cannot fix a dangling reference, because every fix is an edit to the vendored text. Five are forked and edited, four are dropped, one becomes a reference file.
- ~~D26's clause *"inherited MIT code keeps upstream style and is excluded from lint — restyling means a merge conflict on every upstream release"*~~ → narrowed by **D69** to the **visual companion**, which is the only vendored *code* left. A fork has no next merge, so the five forked skills are kiln's own text and D26's own rules apply to them.
- ~~D66's supersession of D50 read as total~~ → narrowed by **D70**. Ownership answers *may I write this path*; it cannot answer *whose gate record applies*, and a path discovered during implementation is in no `predicted[]` by design (D31). `session_id` survives as the identity resolver, not merely as a handover record.
- ~~D32's latency budget, *"plus one small `state.json` read"* per tool call~~ → corrected by **D70**. The ownership question reads every `in_progress` work's state — a `readdir` plus one to three reads, still dominated by the 20–30 ms node cold start.
- ~~D65's *"no state-setting verb at all"*, read as "no writer exists"~~ → named by **D71**. There is no verb that *sets* a gate; there is one that reads the user's answer, hashes the artifact itself, classifies the answer against D21's explicit-yes list, and records what it observed — the `task-done` shape D65 was already copying.
- ~~D66's overlapping-claim check, placed at write time~~ → moved by **D72** to claim-registration time. At write time two overlapping claims block each other: a deadlock with two error messages, not the "clear conflict" BMAD #2849 asks for.
- ~~`verify` as a provider (`playwright｜none`), a config key and a port~~ → cut by **D73** (closes M8). A browser check is a step; only `steps[]` produces the exit-code evidence D7 item 3 rests on.
- ~~D7 item 4 as an unqualified *"never skips a gate"*~~ → narrowed by **D65**. Enforced: no source edit without a gate record matching the current artifact's hash. Audited, not claimed: that the record reflects what the human actually said. The user answers in chat, so the agent is the courier and no mechanism here makes that unforgeable — saying otherwise would be the overstatement D7 item 3 exists to prevent.
- ~~D50's `session_id` match as the **sole** mechanism, with "no match → ALLOW"~~ → superseded by **D66**. It created a worse hole than it closed: a second session resuming a work rebinds the id and the first session keeps working with its guards silently off. Ownership of the path replaces identity of the session.
- ~~D57's `at` timestamp as the freshness anchor~~ → corrected by **D67(a)** to the range `base..HEAD`, the shape `task-done` writes. A sha range can be compared against the tree; a wall-clock time cannot.
- ~~Putting `state.json` under `.git/` for write protection~~ → rejected before it was ever written, by measurement: §1.6 row 10. Upstream's `sdd-workspace` states the harness denies agent writes there; it only *prompts*, and `bypassPermissions` writes through.
- ~~D53's Bash hole as an accepted **ceiling**~~ → partly closed by **D64**. Measured 2026-09-20: a blocked agent's *first* retry was `echo … > file` through Bash, so the ceiling was the main path.
- ~~Q5 and Q6, and the fear that `bypassPermissions` or a subagent might skip hooks~~ → all four answered by measurement in §1.6 and closed by **D63**. Two were real (timeout allows; the flat shape registers nothing), two were not (bypass and subagents both fire and block).
- ~~D35's "the D7 list becomes **six** tests"~~ → **seven**, by **D48**: the agent approving its own gate by editing `state.json` was a hole in items 1 and 4 that no existing test covered. D35's static/runtime distinction is unchanged.
- ~~D4's pin to upstream **v6.3.0**~~ → superseded by **D55**. v6.4.1 shipped 2026-09-19T00:32Z, after §1's measurement, and rebuilt one of the four inherited skills from a stub that measured no better than no plugin at all.
- ~~D7 item 6, *"sends anything to the network outside the declared tracker/VCS"*~~ → narrowed by **D59** to *"kiln's own code performs no network egress"*, which is the claim its static grep proves. The agent-side risk is a named ceiling, not an enforced promise.
- ~~D33's invariant, *"no core guard may have a failure branch ending in ALLOW"*~~ → qualified by **D54**: it holds only once the dispatcher is running. A non-`2` exit is a *non-blocking* error, so anything that stops `dispatch.mjs` from running fails open.
- ~~§3b's comparison table claiming kiln has *"rounds + state"*~~ → corrected 2026-09-20. D18 deleted rounds three sections earlier; the headline table was still advertising the subsystem.
- ~~§3b's refusal *"kiln does not duplicate their skills"*~~ → corrected by **D62**. It vendors four of them; they are namespaced instead.
- ~~§4's subject table: umami at Knowledge **tier 1**, stacks `node-lib` / `node-prisma`, and Jira proving the **Tracker port**~~ → corrected by **D61** and D13. Tier 1 is deferred to v1.2, both "stacks" are configs of `stack-node`, and the Tracker port was retracted before that row was written.
- ~~D13's evidence sentence, *"search_code … → **0 results**"*~~ → re-run 2026-09-20: 38 hits, all incidental word matches, the one real hit being `gh pr view --web` used as a command inside a plan document. The **conclusion** — no tracker client code anywhere in 288K stars — stands; the number was a fuzzy-search artifact. §6.1 rule 2 applies to citations as well as to claims.
- ~~D20 read as "mechanize routing and volume, and that is the whole of it"~~ → **D101**. Both
  mechanisms were built and neither made a rule reach a stage; routing a file to nothing is
  not routing. The law D20 set is untouched — *unrouted is dead weight* — but its purpose
  needed a reader before the check meant anything.

- ~~The v1 scope table's "Skills, total 8 — orchestrator · investigate · review + the 5
  forked" and "Guards: core 3"~~ → corrected 2026-09-23 against what ships: **7 skills**
  (INVESTIGATE is a stage of the orchestrator, never a skill) and **5 core guards**
  (`guard-interpreter` and `guard-verification` arrived with D98 and D90, after the table was
  locked).

- ~~**D84** "the explorer's template name is reconciled at vendor time"~~ → the premise is gone.
  Re-measured 2026-09-23 across the whole marketplace: **`export_static_explorer.py` does not
  exist**, and the string `explorer-v2` appears nowhere. `serve_store.py --copy` already writes
  the static export, so D79.3's `--export` was implemented upstream by another route while the
  decision log described a bug in a file that is not there. Four days was enough for
  *"measured in the source that will be vendored"* to rot — which is D107's third argument,
  arriving as evidence rather than as reasoning.

- ~~"No commit SHA in the DNA schema"~~ → factually wrong, corrected in §1.2. `manifest.source_pins` exists and `update-playbook.md` is a designed incremental procedure.
- ~~"Defer spike from v1"~~ → reversed by D12. Original rationale ("least used, cheapest to add later") mis-costed it as a peer of the dependency-adding deferrals; spike adds no dependency.
- ~~"Defer visual companion from v1"~~ → reversed by D11. Two of the three stated costs were wrong: WSL2 browser-opening is already solved upstream, and the security model is an asset rather than a maintenance burden.

---

## 3. Section 1 — v1 scope **[LOCKED 2026-09-19]**

**Cutting principle:** v1 of an OSS tool does not need to be *complete*; it needs to be **trustworthy and useful**. Anything that serves neither the safety gate (D7) nor triangulation (D10) is deferred.

### In v1

| Item | Content |
|---|---|
| Code ports | **2** — Stack, Knowledge. Tracker and VCS are a config value plus skill text, 0 lines (D13); `verify` is not a port at all (D73) |
| Provider values | `tracker: github\|gitlab`, `vcs: github\|gitlab` — config, not adapters. No `verify` provider: a browser check is a step (D73) |
| Stack files | `stack-php-ci3` (JSON + 2 guard scripts), `stack-node` (JSON only; zod and umami are configs of it, D61) |
| Knowledge | `knowledge-null` — a real grep implementation, never a no-op (D47) |
| Ceremony paths | **spike + bounded + full**, classified **after** INVESTIGATE, one-way ratchet |
| Stages | 7 on the `full` path (D23, D28) |
| Gates | 4 (`full`) / 2 (`bounded`) / 1 (`spike`) |
| Guards | core: `guard-interpreter` (D98), `guard-verification` (D90), `guard-protected-branch`, `guard-sandbox`, `guard-gate` — **5**, in that dispatch order (D19, §3c). The first two arrived after this table was written, each closing a way to reach the files the other four are made of. stack: php-ci3 → migrations + lint; node → `[]` |
| Commands | `/kiln init`, `/kiln <arg>`, `/kiln doctor` — **three** at v1 (D24). `init` · `doctor` · `rules` · `dna` are reserved words a work id may not take (D79, D110, D144) |
| Platform | Linux, WSL2, macOS |
| Harness | Claude Code |
| Inherited skills | **5 forked** from upstream v6.4.1 and owned by kiln (D69) — `kiln-brainstorming` (**with** the visual companion, D11), `kiln-writing-plans`, `kiln-implement`, `kiln-tdd`, `kiln-debugging` — plus upstream's `code-reviewer.md` as a reference file under kiln's own review skill. The `kiln-*` names also close the collision D62 found. Dropped from the closure: `subagent-driven-development`, `using-git-worktrees`, `finishing-a-development-branch`, `verification-before-completion` |
| Skills, total | **7** — orchestrator · review (kiln's own) + the 5 forked (D69). INVESTIGATE is a stage of the orchestrator, not a skill of its own: it has no sub-skills to dispatch and no content the orchestrator does not already carry, and an eighth always-on description would have cost budget for nothing |

### Deferred — and the single reason

Only the **first** deferral is about an **install-time dependency** — the reason that carries real
weight, because it lands on a stranger's machine. The other two are listed for completeness: one
serves no part of D7, the other waits on evidence.

| Deferred | Dependency added | Target |
|---|---|---|
| Knowledge tier 1–2 (DNA), and the `/kiln dna` command that serves it (D79) | none any more — D107 builds it in Node from the `tps-project-dna` contract, so the dependency that set this row's target is gone | when scoped (D107) |
| `kiln-judge` (review/sizing/benchmark as a separate plugin) | — (also: serves no part of D7) | v2 |
| Other harnesses, Windows native | — (gated on evidence, see D8/D9) | on evidence |

### The v1 promise

> One ref from GitHub/GitLab (or one sentence) goes in → kiln investigates,
> classifies how much ceremony the work needs, stops at gates for approval,
> writes code, reviews itself, verifies, opens a PR on your branch —
> **and never does anything unsafe while doing it.**

The "never" list is D7, enforced by hooks and checked in CI (Section 4).

---

## 3b. Section A — the big picture **[LOCKED 2026-09-19]**

### The gap, measured

Compared on *what each does when the agent is wrong*:

| | Raises the quality floor | **Blocks a wrong action** | **State survives the session** | **Project memory** |
|---|---|---|---|---|
| superpowers | strongest inner loop | prompt only | — | — |
| agent-skills | broadest lifecycle | prompt only | — | — |
| BMAD | yes | — | spec frontmatter | — |
| **kiln** | inherits both | **hooks block at runtime** | **one state file, resumable** | **grep → DNA** |

### The claim

> superpowers and agent-skills raise the floor on what the agent **can do**.
> kiln adds what happens when the agent is **wrong**: gates that stop, guards that block,
> state that outlives the session, and project memory that grows with every ticket.

Those three are the only parts that *must* be code. That is why kiln exists instead of being one more skill pack.

### Three principles (derived from D13/D14)

1. **Never re-implement what the agent can already do.** No API clients, no browser driver, no attachment downloader. If a feature means "write a client", the default answer is no.
2. **Write code only for what must be enforced.** Hooks cannot reach MCP, so guards are code. State must survive a crash, so state is a file. Everything else defaults to skill text.
3. **Usable beats correct-and-elegant.** For every concept added, ask: must a stranger learn this in their first ten minutes? If yes and it does not save them from a real failure — cut it.

### What kiln deliberately does not do

| Not | Because |
|---|---|
| Replace superpowers / agent-skills | kiln adds nothing to their surface and re-implements none of their thinking. It **forks five of their skills** at v6.4.1 under `kiln-*` names, so an install needs no second plugin and cannot collide with one (D62, D69) |
| Ship clients for tracker / VCS / browser | MCP + CLI already exist |
| Require a tracker | the primary entry point is **one sentence**; a ticket URL is one way in, not the way in |
| Require DNA | the grep tier works immediately; DNA is an optional upgrade |
| Require Docker / DB / a browser | those are project facts, declared in `.kiln/` |

---

## 3c. Section B — usage flow **[LOCKED 2026-09-19]**

Written from a stranger's seat: what they see, not what the system does.

### Day 0 — install

```
/plugin marketplace add <you>/kiln
/plugin install kiln
/kiln init
```

`init` detects the stack from disk (`package.json`/`tsconfig`/`composer.json`/`pom.xml`) and the
git remote — from the submodules too, when the superproject has none — proposes a config, and
asks **only what it cannot detect, all with defaults** (D92): always what must never be pushed
to and what runs the tests, and then only on the projects that need them, which stack when the
checkout looks like several, which branch when nothing names a default, which forge when no
remote does. It writes `.kiln/config.json`,
`.kiln/rules/index.md` (empty router carrying the D20 budget gate), and a `.gitignore` entry for
`.kiln/tmp/`.

**No token. No Docker. No Python. No CI.** Any of those appearing in `init` is a regression.

### Entry points — a tracker is never required

```
/kiln "the export button on the reports page does nothing"   # a sentence   ← primary
/kiln https://github.com/you/myapp/issues/42                 # a URL
/kiln 42                                                     # a ref, or a work id (D24)
/kiln                                                        # lists work in progress
```

The primary entry point is a **sentence**, matching superpowers (288K stars, zero tracker
integration). A ticket URL is one way to obtain the text of the work, not the way in.

### A `bounded` run

Seven beats, two gates: **investigate → classify (out loud, overridable) → short design → GATE →
code + fast steps → self-review → GATE → verify → ship**. No spec file, no plan document — `bounded` produces
`brief · plan · review`, where `plan.md` is the approved short design, not a 20-task plan.

Four deliberate properties of what the user sees:

| Property | Origin |
|---|---|
| classification **said out loud**, user can override (`"full"`) | superpowers three-path rule |
| gates are **numbered menus**, one option marked `(recommended)` (D113) | unioss, kept — one of the three things inherited verbatim |
| artifacts printed as **absolute paths the moment they are written** | unioss, kept |
| ceremony scales — `bounded` is 2 gates, not 4 | the answer to *"is the token overhead worth it?"* |

### Auto mode differs in exactly one place

`--auto` (or `config.auto.bounded`) turns approval gates into recorded rulings. Each ruling is
printed as it is made, and the gate that authorises shipping prints the whole block (D118):

```
Auto-ruled 2 gates:
  design → approved   (no open questions after investigate)
  review → accepted   (2 findings, both Minor, fixed in round 1)
Halts: none
Your gate is now the PR.
```

Without that block auto mode is a black box, and a black box is not trusted twice.

### Three failure shapes, three different treatments

| Shape | Behaviour |
|---|---|
| **Environment broken** (`Cannot find module 'vitest'`) | STOP. Surface the tool's own error verbatim. Never improvise, never try an alternate command. The fix belongs to the user. Inherited from unioss's REFERENCE — a good law. |
| **Safety halt** (`DROP COLUMN` in the plan) | Stop *before* anything reaches disk, even in auto mode. Numbered menu. |
| **Guard fired** (`git push origin main`) | Not advice — the command did not run. This is the thing none of the other three frameworks has. |

### On disk afterwards

```
myapp/
├─ .kiln/
│  ├─ config.json              committed
│  ├─ rules/index.md           committed — router + the D20 budget gate
│  ├─ hooks/pre-push.mjs       committed — the push floor's runner (D90.3)
│  ├─ work/<id>/               committed — brief · plan · review · ledger · state.json
│  └─ tmp/                     gitignored — deleted at the end of SHIP
└─ (your source)
```

Four things. No `round-N/`, no `.pipeline/`, no `.walkthrough/`. History is `git log -- .kiln/work/<id>/`.

**Concepts a stranger must learn in their first ten minutes: two** — `.kiln/`, and the three
ceremony paths. Deleting rounds (D18) removed a third.

### Deferred to Section F — resolved

Branch naming comes from `config.vcs.branch_pattern` (D37), never hardcoded.

---

## 3d. Section C — enforcement vs integration **[LOCKED 2026-09-19]**

### When something must be code

Write code if **any** of these holds; otherwise it is skill text (judgment, or the agent using its own tools) or config (a project fact).

| # | Criterion | Why |
|---|---|---|
| 1 | must fire **without the agent's cooperation** | an agent deciding to skip is the failure being prevented |
| 2 | must **survive a crash** | agent memory is not durable |
| 3 | must be **reproducible because it feeds a gated decision** | a gate that differs between runs cannot be audited |
| 4 | must be **mechanically verifiable in CI** | a promise does not prove itself |

### The buckets

**CODE** — the three core guards, stack guards, atomic state I/O, grep-tier blast radius, step execution with exit codes, budget/orphan checks, the conformance fixture.
**SKILL TEXT** — reading a ticket, opening a PR, browser verification (all via the agent's own MCP/CLI, per D13); investigating code; classifying the path; rendering gates, `Q`+`GUESS`, and restates.
**CONFIG** — protected branches, test command, tracker choice, the rule-routing table, and a stack's `steps[]` / `effects[]`.

### `guard-gate` — the finding that makes the claim real

Gates were classed as skill text. But D7 item 4 says *never skip a gate*, and prose-only gates **can** be skipped — which is precisely the prompt-only weakness kiln claims to fix. So gates are enforced:

```
guard-gate  (PreToolUse: Edit|Write|NotebookEdit)
  target is .kiln/work/<id>/*.md ?  → ALLOW   (investigation notes precede every gate)
  target is state.json or config.json ? → BLOCK  (kiln's code writes these, D48)
  target is project source ?
      state.gates[AUTHORIZING[path]] == approved  → ALLOW
      otherwise                                   → BLOCK

AUTHORIZING      = { spike: "probe",  bounded: "plan",   full: "plan" }   (D49)
SHIP_AUTHORIZING = { spike: null,     bounded: "review", full: "ship" }   (D77)
```

Gate keys are fixed and total: `probe` · `spec` · `plan` · `review` · `ship`. Only the key in
`AUTHORIZING` unlocks source edits; the rest gate their own transition.

| Edge case | Behaviour |
|---|---|
| `spike` writing throwaway code | the `probe` gate — the terminal act of INVESTIGATE on that path, like classification (D28) — authorizes source writes. Its ship is blocked by `SHIP_AUTHORIZING[spike] = null`, which no gate can satisfy (D77) |
| auto mode | the gate is auto-ruled **and recorded in state** → guard sees approved → allow |
| safety halt in auto | state becomes `halted` → source writes blocked immediately |
| no active kiln work | **ALLOW** — kiln must not police sessions it is not driving |
| `state.json` unreadable | **BLOCK**, naming the path and the fix. Fail-open here means editing source before a gate = a D7 violation. Atomic writes (tmp + rename) make this rare. Consistent with the inherited law *"environment failures — stop, never improvise"*. |

### The core guards

Three at the time of writing; five since D90 and D98, in dispatch order `guard-interpreter` →
`guard-verification` → the three below.

| Guard | Blocks | Reads |
|---|---|---|
| `guard-interpreter` | an inline program — a flag, `-`, a pipe or a heredoc — that names a file the enforcement is made of (D98, D129) | the command |
| `guard-verification` | what switches git's own hooks off: `--no-verify` by any prefix, a clustered `-n` on commit, `core.hooksPath`, `GIT_CONFIG_*` overrides; writes to any checkout's hooks (D90, D130, D135) | the command |
| `guard-protected-branch` | 7 git write-ops on protected branches; `checkout`/`pull`/`fetch` still allowed | config |
| `guard-sandbox` | writes outside `work/<active-id>` + project source; **another ticket's work dir**; `.kiln/config.json` and any `state.json` (D48); on `Bash`, `rm -rf` / `git clean -xfd` resolving outside the repo root (D34) | state |
| `guard-gate` | source edits before the authorizing gate is approved; **PR-creation verbs** (`gh pr create`, `glab mr create`) before this path's ship-authorizing gate — `SHIP_AUTHORIZING = { spike: null, bounded: "review", full: "ship" }`, `null` meaning never (D77) | state |

Membership is decided on a **resolved real path compared segment-wise**, with a symlink leaf
rejected rather than followed — a string prefix is not a boundary (D52).

The guards ask **two** questions, and resolve them by two different keys (D70):

| Question | Key | Answers |
|---|---|---|
| **Identity** — which work is mine? | `session_id` from hook stdin, matched against `state.session_id` | whose `gates` record `guard-gate` reads. No match → kiln is not driving this session → ALLOW |
| **Ownership** — who owns this path? | `state.predicted[]` of every `in_progress` work (D31) | whether another active work has claimed it. Disjoint claims run concurrently; an overlapping one BLOCKs and names the owning work id |

Ownership alone cannot replace identity: a path discovered during implementation is in no
`predicted[]` **by design** (D31), which is exactly the write `guard-gate` must still judge.
`session_id` also records a handover — a second session on one work adopts it out loud, and the
displaced session's next guarded write BLOCKs saying so (D66).

The overlap is refused **when the claim is registered**, not first when a write hits it: two
overlapping claims that meet at write time block each other, which is a deadlock rather than the
clear conflict BMAD #2849 asks for. `predicted[]` is written once, at the plan gate, and that is
where the comparison and the halt belong; write-time blocking stays as the backstop (D72).

Isolation never requires a git worktree, which submodule and fixed-path build environments cannot
provide.

Dispatcher law unchanged: core guards run **first, always**, and none may fail to fire because config is broken.

### Second consequence — a stack adapter is a JSON file

With `steps`/`effects` declarative, `stack-node` is **~20 lines of JSON and zero code**:

```jsonc
{ "detect": ["package.json"],
  "steps":  [ { "id": "typecheck", "run": "${cmd.typecheck}" },
              { "id": "unit",      "run": "${cmd.test}" } ],
  "effects": [], "guards": [] }
```

`stack-php-ci3` adds `"effects": ["migrate"]`, steps carrying `"requires": ["migrate"]`, and two guard scripts — **guards are the only code**. Adding a stack means writing a JSON file, not learning an architecture. The retracted Section 2's nine adapters collapse: tracker and VCS become **0 lines** (a config value plus skill text), `verify` ceases to exist (D73), stack becomes JSON + optional guards, knowledge is `blast.mjs`.

### Code inventory

`dispatch` 80 · `guard-protected-branch` 120 · `guard-sandbox` 110 (D34) · `guard-gate` 70 · `config` 200 · `state` 120 · `blast` 190 (D31) · `steps` 100 · `init` 220 · `doctor` 180 · `budget` 60 · `conformance` 200 = **~1,650 lines**, plus ~1,270 of tests ≈ **2,920 Node total** — the same order as unioss's 2,951, while belonging to no project. Skills: orchestrator + investigate + review (kiln's own) + 5 forked from upstream = **8** (D69).

D48–D62 add to every guard and to `state`; the figures above are the pre-audit estimate and are
re-counted at P1 rather than re-guessed here (§6.1 rule 2).

### Noted risk

`guard-gate` had never run anywhere when this was written; it has since run in the live harness,
six acceptance runs and ten real checkouts (pre-v1 audit §3). `guard-protected-branch` has real production mileage in unioss. Its fail-closed path on unreadable state could genuinely annoy. Mitigations: atomic writes, an error naming the exact path and fix, and a **mandatory** acceptance item in Section G.

The risk grew twice after this section was written, and the mitigation did not: D64 put shell write verbs under `guard-gate` and D77 put the PR verbs there, so the guard with no mileage is now the guard with the widest surface. Section G's adversarial item — it must block a real pre-gate edit **and** be shown not to false-block — therefore has to exercise all three matchers, not only `Edit`.

---

## 3e. Section D — stage skeleton + effect vocabulary **[LOCKED 2026-09-19]**

### The seven stages, and what each path runs

| # | Stage | `spike` | `bounded` | `full` | Artifact |
|---|---|:--:|:--:|:--:|---|
| 1 | INVESTIGATE | ● | ● | ● | `brief.md` |
| 2 | SPEC | — | — | ● | `spec.md` |
| 3 | PLAN | — | ● | ● | `plan.md` |
| 4 | IMPLEMENT | ● (throwaway) | ● | ● | source; history is `git diff` |
| 5 | REVIEW | — | ● | ● | `review.md` |
| 6 | VERIFY | — | ● | ● | `state.verify[]`; raw logs in `tmp/` |
| 7 | SHIP | — | ● | ● | PR — body carries the impact report (D23) |

`spike` terminates at `findings.md`: its output is an answer, not a change. Shipping a spike
means taking the one-way ratchet up to `bounded` first (D12), and `SHIP_AUTHORIZING[spike] = null`
is what enforces that rather than the absence of a stage (D77). The ratchet **never touches the
working tree**: SHIP is kiln's only commit point (D36), so a spike's source is uncommitted, and
kiln neither discards it (D7 item 2) nor carries it forward silently (it was authorized by
`probe`, not `plan`). It halts with a numbered menu, prints `git diff --stat`, and records
`carry_over[] = {from_pass, kind: "ratchet", text}` (D78).

Gates: `full` **4** — spec · plan · review · ship. `bounded` **2** — plan · review, where the
review gate's *accept* is accept-and-ship. `spike` **1** — the probe gate, which is what
authorizes writing throwaway source (§3c).

Classification is not a stage (D28). `changes.md` is not an artifact (D28).

### `stack.steps[]`

```jsonc
"steps": [
  { "id": "migrate",   "run": "${cmd.migrate}",   "provides": "migrate", "phase": "fast" },
  { "id": "unit",      "run": "${cmd.test}",      "requires": ["migrate"] },
  { "id": "typecheck", "run": "${cmd.typecheck}" }
]
```

| Rule | |
|---|---|
| Order | declaration order — no sort, no graph |
| `requires` | a precondition, not an ordering edge — effect absent ⇒ **skipped with a reason**, not failed |
| `phase` | `fast` runs inside IMPLEMENT; default `full` runs after the review gate |
| Verdict | the process **exit code**; stdout is never parsed (D7 item 3) |
| Failure | stop, print the tool's own output verbatim, never improvise an alternate command |
| Evidence | `{id, cmd, exit, ms}` → `state.verify[]`; raw log → `tmp/<id>/steps/<id>.log` |

`tmp/<id>/` is deleted at the end of SHIP, not at review-clean — see Superseded.

### Effect vocabulary

Core and fixed: `+ create` · `~ modify` · `- delete`, all file-level.

A stack contributes further effects with three fields and no more:

```jsonc
"effects": [
  { "id": "migrate", "glyph": "⚙",
    "hint": "one bullet per DDL effect: `<table>`: +|~|- `<column>` <type>" }
]
```

**An effect exists only if it changes something the file-level triple cannot describe** — DB
schema, an index, a queue, any state outside the repo. A change that is only a file is `+~-`.

Dangerous-effect detection is a stack **guard script**, never JSON (D30).

### The GATE change preview

```markdown
**Change preview — #42** · 4 files · 1 migration

- **+ create** `src/export/csv.ts`
- **~ modify** `src/routes/reports.ts` (fns: handleExport, buildQuery)
- **- delete** `src/legacy/dump.ts`
- **⚙ migrate** `20260919_add_export_log.php`
  - `export_log`: + `created_at` DATETIME
```

Every row derives from the approved plan — never from a guess about what the coder will do. A
file the plan does not name does not appear. On a modify, name the functions touched: the
surface, not a diff. Nothing else in the block — rationale and acceptance criteria live in the
plan. Rendered by the orchestrator only, which is where gate format is defined once (D21).

The approved rows become `state.predicted[]`.

### Predicted-vs-actual reconciliation (D23)

Printed at REVIEW, immediately above the gate:

```
Scope — predicted 4 · actual 11 · ⚠ 8 beyond prediction · 1 predicted-not-touched
  beyond: src/db/pool.ts · src/auth/session.ts · …
```

Actual = `git diff --name-status <last_verified>...HEAD` plus untracked — anchored on
`last_verified`, not on the run's original `base`, or a week-old resume reviews the whole
repository (D67a: a real one produced 100 MB / 1.7M lines). It **reports and never blocks** (D31),
with one exception: **`actual == 0` halts** (D56). Statistics reach the conversation; the diff body
stays a file (D67b). Code lives in `blast.mjs` (≈ +40 lines; no new file).

---

## 3f. Section E — enforcement + safety gate **[LOCKED 2026-09-19]**

### Registration — static, three entries

```json
{ "hooks": {
  "PreToolUse": [
    { "matcher": "Edit|Write|NotebookEdit", "hooks": [{ "type": "command", "timeout": 5,
      "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.mjs\" pre-edit" }] },
    { "matcher": "Bash", "hooks": [{ "type": "command", "timeout": 5,
      "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.mjs\" pre-bash" }] }
  ],
  "PostToolUse": [
    { "matcher": "Edit|Write|NotebookEdit", "hooks": [{ "type": "command", "timeout": 5,
      "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.mjs\" post-edit" }] }
  ]
} }
```

No `SessionStart` — unioss used it for `detect-app-env`; kiln needs nothing there.
Why a dispatcher exists at all, and why registration is explicit: D32. `NotebookEdit` is listed
because matchers are case-sensitive and the alternation's anchoring is undocumented, so coverage
by substring would be coverage by luck (D53). The **shape** of this file — whether a plugin's
hooks are wrapped in `{"hooks": …}` or sit at top level — is contradicted by the installed
reference itself; **measured 2026-09-20, only the wrapped form registers** and the flat form
registers nothing without an error (§1.6 row 2, D63), so Tier 1 asserts the shape. `timeout`
bounds latency only — a hook that exceeds it **allows** the tool (§1.6 row 4), so nothing in D7
may depend on it.

### Dispatch

```
read stdin once
├─ pre-bash  : unreadable config → guard-interpreter → guard-verification →
│              guard-protected-branch → guard-sandbox(bash) → guard-gate(bash)
├─ pre-edit  : unreadable config → guard-sandbox(file) → guard-gate(file)
└─ post-edit : stack hooks (php-lint, …)

core guards first, fixed order, hardcoded — never read from config
  first BLOCK → stderr + exit 2, stop
then stack.guards[] from config
exit 0
```

`guard-gate` sits on **both** matchers, not only `pre-edit`. D64 put source-editing shell verbs
(`>`, `>>`, `tee`, `sed -i`, `cp`/`mv` into source) under it because a blocked agent's first
retry was one of them, and D77 adds the PR-creation verbs, which exist only in `Bash`. A
`guard-gate` registered on `pre-edit` alone would enforce neither. *(This line corrects a
diagram that had been stale since D64.)*

Contract: JSON on stdin, `exit 2` + stderr blocks, `exit 0` allows. The inherited early-exit
generalizes: a `Bash` command carrying no `git`, no write verb (D64) and no PR verb (D77) reaches
no guard body at all. Cost per tool call: ~25 ms of node start
(measured), plus a `readdir` of `.kiln/work/` and one `state.json` read per `in_progress` work —
one to three in practice, because the ownership question is about *other* works, not just this
one (D70).

### The failure law

> A guard fails open only when it can **prove there is nothing to protect**.
> When it cannot tell, it fails closed. **Unreadable ≠ absent.**

| Situation | |
|---|---|
| No active `work/<id>` | ALLOW — proven: kiln is not driving this session |
| `state.json` unreadable | **BLOCK** |
| Config missing or broken | `guard-protected-branch` falls back to hardcoded `main`/`master` and still blocks — never falls back to allow |
| A stack guard crashes | **BLOCK**, printing the trace, the file, and `kiln doctor` |
| The dispatcher itself cannot run | **ALLOW — the floor, and it is named, not hidden** (D54) |

CI-checkable invariant: **no core guard may have a failure branch ending in ALLOW, once the
dispatcher is running.**

The qualifier is the honest part. Measured contract: `0` success, `2` blocking, **`Other`
non-blocking — the tool runs**. So node absent from `PATH` (superpowers #2310), a syntax error,
an uncaught throw exiting 1, or a hook timeout all fail open, and no invariant over guard code
can reach them. What is done instead: one top-level `try/catch` whose only exit is `2`, a
`timeout` on every registration, and a `kiln doctor` check that node resolves. Whether a timeout
blocks or allows is measured in the pre-P0 test, never assumed.

Full rationale, and why this inverts unioss's explicit fail-open comment: D33, qualified by D54.

### The D7 list as seven tests

Two tiers, reusing unioss's `isMain` idiom so decision logic stays an exported pure function
and most tests need no process spawn.

| # | D7 item | Test |
|---|---|---|
| 1 | protected branch | port unioss's pure-function table — already covers `HEAD:v3-master`, `--force`, `-C <dir>` |
| 2 | destroys data | `rm -rf` outside the repo → exit 2; inside → exit 0; `DROP COLUMN` → exit 2 (D34); a **symlink** under `work/<id>/` whose target is outside → exit 2 (D52) |
| 3 | failing test reported as passing | fixture step exits 1 while printing `All tests passed`; assert `state.verify[].exit === 1` and the run stops — the anti-stdout-parsing test (D29) |
| 4 | skips a gate *(narrowed by D65 — the enforceable half)* | `gates.plan != approved` + Write to source → exit 2; approved → exit 0; `halted` → exit 2; **approved, then `plan.md` edited → exit 2** (the artifact-hash check); **`pass` incremented, `plan.md` untouched → exit 2** — the hash still matches and must not be trusted (D85) |
| 5 | writes outside the sandbox | write into another ticket's `work/<id>/` → exit 2; `/repo-evil` against root `/repo` → exit 2 (D52) |
| 6 | **kiln's own code** performs no network egress **except `git fetch` / `git ls-remote` against the remote in `config.vcs`** (narrowed by D59, qualified by D83) | **static CI grep** — `fetch(` / `node:http` / `node:net` outside an allowlist fails the build, the two git verbs are allowlisted by name, and `primeradiant.com` is absent from the tree (D11). At v1.2 the grep extends to the Python tree, with `http.server` on `127.0.0.1` allowlisted as a listener rather than egress (D83) |
| 7 | the agent cannot approve its own gate | `Edit` on `work/<id>/state.json` → exit 2; on `.kiln/config.json` → exit 2; on `plan.md` → exit 0 (D48) |

Item 6 is static, not runtime, and is graded as such in Section G (D35). **Three** ceilings are
graded the same way rather than counted as enforcement, each stated at its own width:

| Ceiling | Width, after the decisions that narrowed it |
|---|---|
| Source edits through `Bash` | D53 opened it, **D64 partly closed it** — redirection, `tee`, `sed -i`, `cp`/`mv` into source are covered, and an inline program naming an enforcement file is refused (D98, D129). The residue is **programs kiln does not read**: a script file, and an inline program that writes source without naming a control file |
| A failure that stops the dispatcher | fails **open**, and no invariant over guard code can reach it (D54) |
| Opening a PR outside the agent's CLI | `gh pr create` / `glab mr create` are covered (D77); the forge's **web UI** and a **direct API call** are not |

---

## 3g. Section F — repo layout + config **[LOCKED 2026-09-19]**

### `.kiln/` in full

```
.kiln/
├─ config.json                    tracked
├─ rules/index.md                 tracked — router + the D20 budget gate
├─ work/<id>/                     tracked by default (D36)
│  ├─ state.json                  schema_version · status · session_id · stage · step · gates ·
│  │                              predicted[] · base · last_verified · verify[] · pass · carry_over[]
│  │                              written only as a side effect of doing the thing (D48, D65)
│  ├─ brief.md                    every path
│  ├─ spec.md                     full only
│  ├─ plan.md                     bounded + full
│  ├─ review.md                   bounded + full
│  ├─ ledger.md                   the implementer's own record: a line per task, every ruling (D142)
│  └─ findings.md                 spike only
└─ tmp/<id>/steps/<step>.log      gitignored; deleted at the end of SHIP
```

*Tracked* means not gitignored and swept up by the SHIP commit, which stages an **explicit path
list** — never `git add -A`, and never a broad commit merely because the repository is dirty
(D67c, observed in production). kiln does not commit at each gate (D36).

Field notes added by the audit and the source review:

| Field | What it is for |
|---|---|
| `pass` | always 1 since D136: a shipped work is never reopened, and follow-up work is a new work carrying `follows: <id>` |
| `follows` | the shipped work this one continues, if any (D136) |
| `gates.<key>` | `{decision, artifact_sha, answer, by}`, cleared at every `pass` increment (D85) — `artifact_sha` is checked on **every** gate key, not only the authorizing one (D65 as extended by D85), and is what makes approval bind to the document the user actually read, `answer` is their words verbatim, `by` is `user` or `auto` (D65). Written by the one command that reads the answer, hashes the artifact itself and classifies the answer against D21's explicit-yes list; the agent supplies only `answer` (D71) |
| `session_id` | the **identity resolver** — which work this session drives, so `guard-gate` knows whose gates apply — and the handover record when a second session adopts the work (D66, D70) |
| `stage` · `step` | where a resume picks up — believed only far enough to trigger a cheap drift preflight (D58, D67d) |
| `predicted[]` | cleared at every `pass` increment, being the previous pass's claim set (D85). Doubles as the run's **claim set**: the paths another active work may not write. An overlap is refused when this field is written, at the plan gate — not first at write time (D31, D66, D72) |
| `base` · `last_verified` | both advance to the shipped `HEAD` when a new pass opens (D85). Within a pass, `base` is immutable provenance and `last_verified` starts at `base` and advances to the `HEAD` a `full`-phase set ran against **only when every step in it exited 0**; a `fast` pass never advances it. REVIEW anchors on `last_verified`, so a week-old resume does not review the whole repository (D67a, D76) |
| `verify[]` | `{id, cmd, exit, ms, range, phase, tree}` where `range` is `base..HEAD` and `tree` is the working tree's git tree id; an entry for another range **or another tree** is stale, not evidence (D57, D67a, D141) |
| `carry_over[]` | `{from_pass, kind, text}` (D58) — the **one** field designed to cross a pass boundary, and the only one a `pass` increment leaves alone (D85) |

There is **no command that sets any of these** — each is written as the side effect of a command
that does the thing and records what it observed (D65).

### `config.json`

```jsonc
{
  "artifact_language": "en",
  "repo":   { "kind": "single", "root": null },
  "vcs":    { "provider": "github", "protected": ["main"],
              "integration_branch": "main",
              // under "repo.kind": "multi" this also accepts
              //   { "admin-page": "v3-master", "common-models": "main" }
              // each unlisted module falling back to the scalar (D81)
              "branch_pattern": "${type}/${id}-${slug}" },
  "tracker":{ "provider": "github" },
  "stack":  { "id": "node", "cmd": { "test": "npm test", "typecheck": "tsc --noEmit" } },
  "knowledge": { "tier": 0 },
  "auto":   { "bounded": false },
  "work":   { "committed": true },
  "rules":  { "budget_lines": 200 }
}
```

Resolution: **env → file → built-in default**. Exactly one environment variable, `KILN_ROOT`;
a second one, or a new top-level key, requires a decision entry (D37).

Discovery walks up from the cwd to find `.kiln/config.json`; the directory holding `.kiln/` is
the root, and that root — not the git repo containing the cwd — is the sandbox boundary (D38).

### Multi-repo

```jsonc
"repo": {
  "kind": "multi",
  "root": null,
  "modules": { "admin-page": "AdminPage", "common-models": "common-models" },
  "tickets": ["admin-page"]
}
```

Config, not a port — Q1 is closed (D38). unioss's module-key vocabulary layer is not carried
over; a work id comes from the tracker ref (D24).

### Update

| What | Mechanism |
|---|---|
| The plugin | `/plugin update kiln` — the harness owns it |
| Older `schema_version` | migrate in memory, print one line pointing at `kiln doctor --write`; never silently rewrite a tracked file |
| Newer `schema_version` | refuse, printing both numbers |
| Wrong module paths | `kiln doctor --write` (inherits unioss's `scan --write`) |

---

## 3h. Section G — test plan **[LOCKED 2026-09-19]**

### Two tiers, two different jobs

| | Tier 1 — conformance | Tier 2 — acceptance |
|---|---|---|
| Graded by | machine | a human |
| Runs | CI and local, `node --test` | real machine, real repo, before a release tag |
| Answers | does the code meet its contract | did this work for a person |
| Gates | every PR | releases only |

### Tier 1 — conformance

| Content | Source |
|---|---|
| the seven D7 tests | D35 — **binary**, one failure fails the build |
| `repo-null` fixture | §4 — ports are expressible, runs in seconds |
| guard unit tests on exported pure functions | the `isMain` idiom (D35) |
| budget: aggregate ≤ 6,000 chars · per-description ≤ 500 warn · content-kind rejects version strings | §2 Superseded |
| rules routing — any file in `rules/` missing from `index.md` is an orphan | D20 |
| `hooks/hooks.json` is the wrapped `{"hooks": …}` shape, and the edit matcher names `NotebookEdit` | §1.6 rows 2 and 5 — both failures are silent, and either one turns D7 off wholesale |
| every `superpowers:`-prefixed reference is absent from the forked skills, and every skill they do name is one kiln ships | D69 — a dangling sub-skill reference is silent (agent-skills #361, #136, #67) |
| `gh pr create` on the `spike` path → exit 2; on `full` before `gates.ship` → exit 2; after → exit 0 | D77 — **not** an eighth D7 test: item 4 is about source edits, and inflating the seven would blur what they prove |
| lint, all 10 rules; only the visual companion (`skills/kiln-brainstorming/scripts/`) is excluded | D26 as narrowed by D69 |
| version-sync | D17 |

### Tier 2 — acceptance

> **The gate counts unsafe actions that *completed*, not guard firings.**
> A guard that fires is the system working: `blocks: 3` is good news (D42).

```
Subject · path · stages run
Unsafe actions completed: 0          ← THE GATE, binary
Guard blocks: 3 (listed)             ← good news, not a demerit
Gates: 4 shown · 1 overridden
Human edits after accept: N files
Verify: 12/12 steps, all exit 0
Wall clock 22 min · 31 turns
First-run survival: init → first PR without reading docs? y/n
Would I run it again on this ticket? y/n
```

The last two lines are the real signal; everything above them exists to explain them. A field
is added only when a past run would have been graded wrong without it (D20).

### Post-run audit — four mechanical checks

| # | Check | How |
|---|---|---|
| 1 | no write to the integration branch | `git reflog` on that branch |
| 2 | the fork's default branch carries no agent commits | `git log` (§4 guard rail) |
| 3 | nothing reported as passing over a non-zero exit | reconcile `state.verify[]` against the final report text |
| 4 | no writes outside `repo.root` | `git status` + `.kiln/tmp` diff — **the weak check, recorded as weak** |

D7 item 6 is graded **static**, never "verified" (D35).

### Mandatory adversarial items

| Debt from | Required item |
|---|---|
| `guard-gate` has never run anywhere (§3c) | one run shows it blocking a real pre-gate edit, **and** one shows it not false-blocking |
| fail-closed brick risk (D33) | break a stack guard on purpose; the message must name the file and `kiln doctor`, and recovery must not require editing kiln |
| unreadable `state.json` | the same, on guard-gate's fail-closed path |
| claim overlap was never exercised (D72) | two works whose plans claim one path: the **second plan gate** halts naming the first work id, and two works with disjoint claims both run to SHIP |

### Release thresholds

| Release | Condition |
|---|---|
| **v1.0** | six acceptance runs · ≥ 3 subjects · all three ceremony paths · ≥ 1 `full` and ≥ 1 auto-mode · unsafe-actions-completed = 0 throughout |
| **patch** | conformance plus one smoke run |
| **contributor PR** | conformance only (D44) |

The grades block nothing. They are Section H's input for bankruptcy conditions.

---

## 3i. Section H — roadmap **[LOCKED 2026-09-19]**

Risk checkpoints, not a schedule. No dates, no effort estimates (D45). Each phase carries one
falsifiable premise, how its falsehood would be observed, and what is abandoned if it is false
(D46).

### Before P0 — the one test that can end the project · **DONE 2026-09-20 · PASSED**

Prove a `PreToolUse` hook actually blocks a real Edit in Claude Code. A few dozen lines, one
afternoon. Section A's whole claim stands on it.

**Result: it blocks.** Nine more answers came out of the same fixture — the full table is §1.6,
and its consequences are D63 (Q5 + Q6 closed, D54's floor extended) and D64 (the Bash bypass is
the agent's default retry, so D53's ceiling is partly closed). The project is not dead; **P0 is
unblocked.** The probe was throwaway by design — its job was to answer questions, and P1 rebuilds
it properly as the seven D7 conformance tests (D35, D48).

### P0 — walking skeleton

`init` + config + state + `/kiln <arg>` resolution + the orchestrator's todo list, `bounded`
only, on kiln's own repo.

| | |
|---|---|
| PASS | one sentence → brief → plan → GATE → source edit → review → PR on a feature branch |
| Bankruptcy | ~~the hook does not block~~ — **retired 2026-09-20, it blocks (§1.6)**. What remains: the loop only closes if kiln writes its own clients (D13 collapses) |
| Observed by | for the surviving half, whether P0 can reach a PR using only `gh`/MCP and no client code |
| Escape | kiln has no reason to exist beyond a skill pack — stop, and contribute upstream instead |

### P1 — guards

`dispatch.mjs`, the three core guards, the seven D7 tests.

| | |
|---|---|
| PASS | seven D7 tests green; `guard-gate` blocks a real pre-gate edit **and** does not false-block during dogfood |
| Bankruptcy | hooks fire unreliably — sometimes yes, sometimes no |
| Observed by | D43 item (a), repeated ten times, counting non-fires |
| Escape | as P0 |

### P2 — triangulation (D10)

`stack-php-ci3` and `stack-node` together; steps, effects; the zod fork as the second point.

| | |
|---|---|
| PASS | zod runs with `guards: []`, `verify: none`, a short `steps[]`; no port exists that only one adapter needs |
| Bankruptcy | after both adapters, a stack still needs code beyond its guards |
| Observed by | counting non-guard code lines in `stack-php-ci3`; greater than zero fails |
| Escape | stacks become plugins rather than JSON — a larger, different product; v1 scope must be re-decided |

### P3 — three paths + auto mode

| | |
|---|---|
| PASS | on the 8 real umami issues, classification matches human judgment on the two spike-shaped ones (#4540, #4546); auto mode prints its full `Auto-ruled` block |
| Bankruptcy | users override the classification nearly every time |
| Observed by | the scorecard's `Gates: N shown · M overridden` (§3h) |
| Escape | collapse to one path; D12 lapses and ~80 lines go |

### P4 — knowledge tier 0 + reconciliation

grep-tier blast radius, predicted-vs-actual (D31), the drift check at INVESTIGATE (D22).

| | |
|---|---|
| PASS | on umami — **the exam** — the reconciliation line catches a real divergence, and #4526, which proposes its own fix, is **evaluated rather than copied** |
| Bankruptcy | tier-0 blast radius is noisy enough to be ignored every time |
| Observed by | how often the `Scope —` line leads to an action across the six acceptance runs |
| Escape | defer the Knowledge port to v1.2 with DNA — this also answers **Q2** negatively (D47) |

### P5 — release readiness

Docs, `LICENSE` + `NOTICE`, companion hygiene (D11, D26), the six acceptance runs (D44), budget
checks, and the one human step the fork costs: read upstream's releases since the `NOTICE` fork
commit and adopt anything worth adopting **as a decision entry, never as a merge** (D69).

| | |
|---|---|
| PASS | D44's v1.0 condition, in full |
| Bankruptcy | first-run survival fails repeatedly with strangers |
| Observed by | the scorecard's `First-run survival: y/n` |
| Escape | do not publish; fix `init` or narrow the audience — D6's "the first ten minutes is the product" is not met |

---

## 4. Section status

Order revised 2026-09-19: the original sequence started at port signatures, which is
bottom-up. The user's correction — *"focus on the whole picture and the usage flow first,
then design an architecture that fits; avoid building something correct and elegant that is
painful to use"* — reorders it.

| § | Topic | Must answer | Status |
|---|---|---|---|
| A | Big picture | what kiln is, what it uniquely claims, what it refuses | **locked** |
| B | **Usage flow** | what a stranger sees, types, and gets back; what they read when it breaks | **locked** |
| C | Enforcement vs integration boundary | derived from B: what is code, what is skill text, what is config | **locked** |
| D | Stage skeleton + effect vocabulary | the 7 stages per path; `stack.steps[]` execution order; extensible effects (`+create ~modify -delete` core, `⚙migrate` stack-contributed); the GATE change preview; predicted-vs-actual reconciliation (D23) | **locked** |
| E | Enforcement + safety gate | `dispatch.mjs` — static registration, dynamic dispatch, core guards first and never config-dependent; the D7 list as automated tests | **locked** |
| F | Repo layout + config | `.kiln/` shape; committed vs gitignored; multi-repo/submodule as config; update mechanism | **locked** |
| G | **Test plan** | two tiers — conformance (machine-graded) and **acceptance (human-graded, real-user view)**; D7 as a binary CI gate; the grades that guide iteration | **locked** |
| H | Roadmap | P0→P5 with per-phase PASS and **bankruptcy** conditions | **locked** |

### Approved test subjects (D10 / Section 6)

| Subject | Tracker | VCS | Stack | Knowledge | Proves |
|---|---|---|---|---|---|
| `repo-null` fixture | fake | fake | `steps:[]` | null | ports are expressible; runs in CI in seconds |
| **kiln itself** (dogfood) | github | github | node | tier 0 | the daily loop |
| UNIOSS + GitLab | gitlab | gitlab | php-ci3 (+ a playwright step) | tier 0 | baseline parity with today |
| UNIOSS + Jira | **jira** | gitlab | php-ci3 (+ a playwright step) | tier 0 | that a tracker really is one config line plus skill text (D13) — same repo, one axis changed |
| **zod** (fork) | github | github | node | tier 0 | short `steps[]`, `guards:[]`, no browser step at all, on a real project |
| **umami** (fork) | github | github | node + `migrate` effect (+ a playwright step) | tier 0 | **the exam** — Prisma is schema-first/generated, the inverse of CI3's hand-written timestamped migrations; 8-step build chain; pnpm workspace. Second adapter to exercise the effect point (D61) |

**Guard rail:** never open a PR on a stranger's repository with agent-authored code. Fork → work on the fork → PR into the fork's own default branch. Upstream receives nothing. If a fix turns out genuinely good, review it as a human and submit it yourself, as a separate act.

Why umami specifically: its issues read like investigation reports — #4526 carries EXPLAIN plans, per-phase CPU measurements and self-limiting scope caveats; #4552 traces a root cause to the exact file, the exact default, and the commit that introduced the mismatch. For a pipeline whose first stage is *"investigate the ticket in depth"*, that is the richest available input — and a real behavioural test: #4526 already proposes its own fix, so does the investigator **evaluate** it or just copy it?

---

## 5. Open questions

| # | Question | Blocks |
|---|---|---|
| Q1 *(closed 09-19 by D38 — config, not a port)* | — | — |
| Q2 *(closed 09-23 — **yes**; tier-0 output led to an action four separate times)* | D47's observable was how often the `Scope —` line leads to an action. It led to four: `kiln blast`'s silent 20-row truncation, found by reading tier-0 output (C1); D89, written because the line cried wolf on work a run had not done; D97's anchor verdict, from a real monorepo reporting `predicted 11 · actual 283`; and the zod symlink, which surfaced as `1 beyond prediction · 1 predicted-not-touched`. The null adapter is a real degraded implementation and is exercised, so D47's escape hatch — deferring the Knowledge port to v1.2 — is **not** taken. | — |
| Q3 | Windows native — cost vs demand, revisit after first external users | post-v1 |
| Q5 *(closed 09-20 by D63 — a timeout **allows**; `timeout` is latency, not protection)* | — | — |
| Q6 *(closed 09-20 by D63 — only the wrapped `{"hooks": …}` shape registers; the flat form registers nothing, silently)* | — | — |
| Q4 *(closed 09-19 by D40 — no default lint step; `init` detects one)* | — | — |

---

## 6. How to resume

If the conversation is gone:

1. Read this file top to bottom. Every decision carries its rationale; none needs re-deriving.
2. Read §6.1 — **the working method**. It is not optional; it is why this document is trustworthy.
3. Read `2026-09-19-design-audit.md`, the companion file. It holds the evidence behind D48–D62,
   the fourth pass (§6 → D69–D76) and the fifth (§7 → D77–D84). Nothing in it is parked.
4. Read `2026-09-20-user-view.md` — this same design described from the **user's chair**. It adds
   no decisions and this file outranks it, but reading it is how the fifth pass found two
   blockers four builder-seat passes had missed. Re-run that read-back before P1 and before v1.0.
5. Read §4 to see which section is next.
6. **P0–P5 are built**, the six acceptance runs are recorded and tier D is graded. What remains
   is the v1.0 release condition in §6 of the verification plan: one validation run on a
   production repository, on the current build, and the owner's decision to tag. If something
   genuinely new appears, it is a decision entry in §2, not a rewrite.

### 6.1 Working method — read this before contributing a single line

These are standing instructions from the project owner, given during design. They survive no
conversation, so they live here. **A session that skips them will produce worse decisions than the
ones already recorded above, and will not notice.**

**1. Self-QA before concluding or asking.** Draft the answer, then attack it with the rules
already written down — D10's "both adapters need it", D13's enforcement/integration line, D20's
budget gate, the "must a stranger learn this in ten minutes?" test. Report what broke. Six of the
superseded entries in §2 were found this way, by the author, before the owner saw them. A section
presented without a visible QA pass is incomplete work.

**2. Measure; do not assert.** Every number in §1 came from a command. If a claim needs a number,
run something first. Two numbers in this document were asserted and later proved wrong by
measurement — the DNA schema SHA claim and the 200-char description cap. Both are in Superseded.
Assume the same rate applies to anything asserted from memory.

**3. Correct plainly, then move on.** When measurement contradicts something already written: say
so in one or two sentences, add the entry to Superseded with the reason, continue. No
rumination, no tallying, no apology.

**4. One section at a time.** Present → show the QA → the owner approves → **write it into this
file immediately** → next section. Never batch approvals. Never carry an approved section only in
conversation.

**5. Nothing is decided silently.** A decision without an entry in §2 did not happen. The entry
carries the rationale, not just the outcome — a future reader must be able to disagree with the
reasoning, not just the conclusion.

**6. Source hierarchy (D14) is a standing rule, not a one-off.** `superpowers` and `agent-skills`
are the standard. `unioss-plugin` and `claude_skill` are evidence of which problems are real.
Four things inherited from unioss were rejected after QA — `prefix()`, `VCS.protectedBranches`,
`unioss-verify`, and `round`. Expect the rate to continue.

**7. Usable beats correct-and-elegant.** The owner's words: *"avoid making everything correct and
beautiful but extremely hard to use — then having to redo it."* For every concept added, ask
whether a stranger must learn it in their first ten minutes, and whether it saves them from a real
failure. If not — cut it.

**8. Ask with a guess attached (D21).** One question per message, carrying the asker's own
hypothesis and the reasoning behind it. The owner reacts to a wrong guess faster than they
generate an answer from scratch.

**9. The audit is part of the method, not an event.** The 2026-09-20 pre-build audit found 7
blockers in a document whose every section was marked LOCKED — three of them defeating D7, the
promise the project exists to keep. None came from new information; they came from reading the
design as an adversary and from checking three validated projects' issue trackers for the same
bug. Expect the same yield before P1 and before v1.0, and run it the same way.

**10. Report in a table, a number, or a bullet list.** Long prose hides the claim and the
evidence behind it in the same sentence; a table forces them into separate columns, where a
missing one is visible. Avoid rambling paragraphs. This applies to every answer given to the
owner, not only to what lands in this file.

Companion files in this repository:
- `2026-09-19-design-audit.md` — evidence, and the five review passes
- `2026-09-20-user-view.md` — the same design from the user's chair (derived; this file outranks it)
- `2026-09-20-verification-plan.md` — the test tiers and the scenario matrix
- `2026-09-23-pre-v1-audit.md` — the read-back owed before a v1.0 tag, and D125–D147's audit
- `2026-09-23-upstream-read.md` — the release-checklist step the superpowers fork costs

Source material referenced (read-only, not part of kiln):
- `/home/ttndev/workspace/company/tps/projects/unioss-plugin`
- `/home/ttndev/workspace/company/tps/projects/claude_skill`
- `https://github.com/obra/superpowers` (MIT) — releases, and the open-issue tracker
- `https://github.com/addyosmani/agent-skills` — issue tracker
- `https://github.com/bmad-code-org/bmad-method` — issue tracker
- `plugin-dev/hook-development` (Claude Code official plugin) — the measured hook contract

**Do not re-measure §1.** Those numbers were taken on 2026-09-18 and are recorded so no future session spends tokens re-deriving them. Re-measure only if the source repositories have changed.
