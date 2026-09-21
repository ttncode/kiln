# Security policy

kiln installs `PreToolUse` hooks, so its code runs inside your agent's session, with your
privileges, before commands you did not individually approve. That makes two classes of
report different from an ordinary bug, and both are welcome.

## What counts as a vulnerability

1. **A guard that allows what it promises to block.** The seven promises are listed in the
   [README](README.md#what-it-blocks) and proved in `tests/d7.test.mjs`. A sequence that
   pushes to a protected branch, edits source without an approved gate, writes outside the
   sandbox, or opens a pull request from a `spike` is a vulnerability report — not an issue.
2. **Anything kiln's own code does that the user did not ask for.** Network egress beyond
   `git fetch` / `git ls-remote` against the configured remote, a write outside the work
   directory, or a destructive git operation.

## What is a known ceiling, not a vulnerability

These are documented limits, listed in the README and in the design log. Reporting one is
useful only if you have a way to close it.

- **Interpreters and heredocs.** `python -c` and a heredoc into a script can edit source
  without passing a watched verb. Closing that needs shell parsing, which kiln deliberately
  does not do.
- **A dispatcher that cannot start fails open.** If `node` is missing from `PATH`, the hook
  never runs, and a hook that never runs is allowed. `kiln doctor` checks for this because
  nothing at runtime can.
- **A hook that exceeds its timeout allows the tool.** Measured, not assumed. Nothing in the
  guard list depends on a timeout to hold.
- **The forge's web UI and direct API calls** are outside the pull-request gate. A push to a
  protected branch is covered; a click in a browser is not.

## Reporting

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). It is enabled. Please do not open a public issue for
anything in the first list above.

Include the guard you expected to fire, the exact command sequence, your Node version, and
your harness version. A failing test is the fastest possible report.

You will get an acknowledgement within a week. There is no bounty; this is a one-maintainer
project and it says so rather than implying otherwise.

## Supply chain

- **Zero runtime dependencies.** `package.json` lists ESLint as the only dev dependency. The
  code that runs in your session is the code in this repository.
- **Everything the hooks do is in `hooks/dispatch.mjs` and `lib/guards/`** — under 600 lines,
  readable in one sitting. Reading them before you install is a reasonable thing to do.
- **Forked code is named.** [NOTICE](NOTICE) records the upstream commit for every forked file
  and what changed. kiln forks rather than tracks, so upstream fixes do not arrive on their
  own — reading upstream releases forward from that commit is a step in kiln's own release
  checklist.

## Supported versions

Pre-1.0. Only the latest release gets fixes.
