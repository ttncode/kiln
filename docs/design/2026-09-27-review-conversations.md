# Two review conversations: the human walkthrough, and answering a pull request's review

> **Status: design, revised once after an adversarial review.** Phase B, items 6 and 7 of the
> skill-parity plan. The review's findings and the answers are the last section.

## 1. The walkthrough (BMAD `bmad-walkthrough`, `5e33d3c`, MIT)

**What it is.** "Guide a human review of a commit, PR, file, or directory", one block at a time
(intent, broad strokes, one concern per slice, periphery), with a review narrative and an
append-only log, and moves the user picks (thoughts, second opinion, formal review, test,
drive, wrap-up). A block is done only when the user says so.

**Where it sits in kiln.** Before the review gate records anything. The review gate gains one
option, **"Walk me through the change first"**. Choosing it records nothing — it is neither an
approval nor a rejection — and invokes `kiln-walkthrough` over this work's change. Block 1's
intent is the brief and the plan's `**Goal:**` line from `intent.md` (BMAD pastes a plan's intent
section when one exists and otherwise writes one; kiln has the brief and the goal). When the user
wraps up, the orchestrator renders the review gate again.

**Read-only in kiln.** BMAD's walkthrough lets the user edit and test mid-review. In kiln the code
under review is what the gate approves, and on `bounded` approving the review gate is approving
the ship, so an edit made during the walkthrough would ship unreviewed. A finding the user wants
fixed goes back through REVIEW's fix pass, which writes the readers' inputs again and records it
in `review.md`; the walkthrough's own moves are thoughts, second opinion, test and drive, which
change nothing.

**Where its files live.** For a work, `.kiln/tmp/<id>/walkthrough/` (removed at ship or close,
so what matters reaches `review.md` through the fix pass). Invoked by name with no work open,
`.kiln/tmp/walkthrough/<date>-<slug>/`.

**Copied as BMAD wrote it**, one kiln file per upstream file — `SKILL.md` (the rules of
`workflow.md`), `step-01-orientation.md`, `step-02-narrative.md`, `step-03-walkthrough.md`,
`templates/log-template.md` — each an `edited` copy in `copies.json` with its edits listed: the
render step and the `{% %}` / `{{ }}` blocks resolved to their defaults, the artifact path above,
"ask whether to commit" replaced by "kiln commits once, at SHIP (D142, D206)", "Formal review"
naming `kiln-review`, wrap-up's follow-through being the review gate.

## 2. Answering a pull request's review (superpowers `receiving-code-review`, `8ca22db`, MIT)

**What it is.** A discipline for review feedback: read, restate, verify against the codebase,
evaluate, respond or push back, implement one item at a time; no performative agreement; a
YAGNI check; replies in the inline thread (`gh api …/pulls/{pr}/comments/{id}/replies`).

**The gap in kiln.** A shipped work is not reopened (D136), so feedback on its pull request is a
follow-up work, and SHIP of that work opens a **second** pull request on a new branch — the
reviewer's comments stay on the first, unanswered.

**The design.**
- **Recognise it.** `kiln resolve` looks a URL up in every work's `opened` list; a match answers
  `follow_up` with `follows` set, so pasting the PR's URL routes to the right work. A pasted
  comment with no URL is a sentence, routed as today.
- **Record the branch.** `kiln ship --opened` records the branch per repository beside each url
  (`opened: [{ url, branch, module }]`); an older string-only record reads as url alone. The
  branch is never recomputed from `branch_pattern`, which may have changed or been overridden.
- **Start from that branch.** Before `kiln open <new> --follows <id>`, the orchestrator runs
  `git fetch` (allowed egress), switches each repository to the recorded branch and
  `pull --ff-only`s it, so the follow-up's base is the predecessor's tip and its diff is only the
  fix. If a switch or pull fails, it stops and says so.
- **One pull request per repository, not two.** `kiln ship` for a follow-up prints, per
  repository: where the predecessor recorded a branch, "if <url> is still open (check with your
  own `gh pr view <url> --json state`), push to <branch> and it updates; otherwise open a new
  pull request"; elsewhere, a new branch as today. kiln stays offline and does not claim a pull
  request's state it cannot see (D13).
- **Replies after the push.** The skill's thread replies are posted only after the push, with the
  text the user approved at the review gate — a "fixed" before the fix is on the remote is false.
- **The skill.** `receiving-code-review` is copied into `skills/kiln-receiving-review/` as an
  `edited` copy: the feedback is triaged at INVESTIGATE of the follow-up work, each item it
  accepts becomes a plan task, and every gate is given again (D136).

## Decisions

Each part lands with its own entry: the walkthrough option and skill; the `opened` record with
branches and `resolve` matching a URL; the follow-up's start on the predecessor's branch and the
ship plan's per-repository wording.

## Tests

`copies.json` records for every copied file; the review gate lists the walkthrough option and
records nothing for it; `resolve` of a recorded PR url is a `follow_up`; `--opened` records
branches and an old string record still reads; the ship plan of a follow-up names the recorded
branch per repository and a new branch where none was recorded; the skills test pins the
read-only rule and the reply ordering.

## The review, and what changed

Blockers: a branch on the remote does not mean the pull request is open (GitHub keeps merged
branches) → no `ls-remote`, a conditional the agent checks with its own `gh`; a follow-up opened
from `main` would diff the predecessor's commits → switch to the recorded branch before opening.
High: the branch was not recorded → recorded per repository at `--opened`; edits during the
walkthrough would ship unreviewed → read-only; multi-repository follow-ups → per repository;
nothing recognised feedback on a shipped PR → `resolve` matches `opened` urls. Medium: one copy
per upstream file as `edited`; `intent.md` and D136 cited correctly; the gate option records
nothing; replies after the push; a place for the walkthrough's files with no work; decision
entries named.
