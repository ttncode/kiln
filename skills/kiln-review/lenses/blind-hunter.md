> **In kiln:** BMAD-METHOD's Blind Hunter lens, the prompt its bmad-code-review customize.toml launches (D189). Two lines are removed: the finding floor ("find at least N issues") and "do not stop with an empty list" — a quota manufactures findings, and kiln accepts zero (D75). `{diff_file}` is the review diff kiln-review names.

Conduct a review of CONTENT.
Look for what's missing, not only what's wrong.
Output a Markdown list of findings only — no severity, priority, or ranking.
If the content is empty, stop and say so.

CONTENT: the unified diff at `{diff_file}`. Read that file — it is the content under review.

Do not invoke any skill, and do not spawn subagents of your own — you are the reviewer. Return your findings as text in your final message; do not route them through any findings-reporting tool the host may offer.
