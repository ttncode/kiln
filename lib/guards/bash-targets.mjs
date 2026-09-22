/**
 * No shell parsing (D34's line holds): no subshells, no eval, no interpreters. Quotes are
 * read, because which characters are syntax and which are data is a lexical fact the shell
 * settles before any of them run — and reading them wrong is how a SELECT became a write.
 * A token scan catches the verbs a blocked agent actually reaches for —
 * measured in §1.6 finding 11, where the first unprompted retry after a blocked Write
 * was `echo "hello" > <path>`. What stays uncovered is `python -c` and a heredoc into a
 * script, and that residue is the ceiling, named rather than claimed away.
 */
const REDIRECT_OPERAND = /^("[^"]*"|'[^']*'|[^\s;|&]+)/;
const SED_IN_PLACE = /\bsed\b[^;|&]*\s-i\b/;
const DESTRUCTIVE_RM = /\brm\b(?=[^;|&]*\s-[a-z]*r[a-z]*\b)(?=[^;|&]*\s-[a-z]*f[a-z]*\b)/;
const GIT_CLEAN = /\bgit\b[^;|&]*\bclean\b[^;|&]*-[a-z]*[xd][a-z]*f|\bgit\b[^;|&]*\bclean\b[^;|&]*-[a-z]*f[a-z]*[xd]/;

const COPY_VERBS = new Set(["cp", "mv", "tee", "install"]);

/**
 * A heredoc body is data, not commands. Scanning it found `> Recommendation: approve.`
 * inside a plan document and read the markdown blockquote as a shell redirect — so
 * writing plan.md was blocked for want of the plan gate, which is the plan stage
 * deadlocking on its own output.
 *
 * Content is not lost by stopping here: stack guards receive the whole command as the
 * written content, so a DROP COLUMN inside a heredoc still reaches them.
 */
/**
 * Every index the shell will read as syntax rather than as data. One lexical walk, because
 * separators and redirect operators are the same question asked twice, and answering it
 * once for `>` while splitting on a quoted `;` first is how a write became invisible.
 */
function* unquoted(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else {
      yield i;
    }
  }
}

function beforeHeredoc(command) {
  const marker = /<<-?\s*['"]?\w+/.exec(command);
  return marker ? command.slice(0, marker.index) : command;
}

const SEPARATORS = ["&&", "||", ";", "\n"];

function separatorAt(text, at) {
  return SEPARATORS.find((token) => text.startsWith(token, at)) ?? null;
}

/**
 * A separator inside quotes is data, by the same rule that governs `>`. Splitting first and
 * reading quotes afterwards is what broke: `echo "...drop_column('users','email');" > file`
 * split at the `;` in the DDL, so the redirect landed in a fragment that opened with an
 * unterminated quote and the write became invisible.
 */
export function segmentsOf(command) {
  const text = beforeHeredoc(String(command ?? ""));
  const parts = [];
  let start = 0;
  for (const at of unquoted(text)) {
    const separator = separatorAt(text, at);
    if (!separator || at < start) continue;
    parts.push(text.slice(start, at));
    start = at + separator.length;
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function unquote(token) {
  return token.replace(/^["']|["']$/g, "");
}

/**
 * A quoted run is one token. That is a lexical rule, not a parse — D34's line is about
 * not interpreting a shell, and splitting `'$a\\// a'` into two arguments misreads what
 * the shell will pass, which is how a sed script became two phantom paths.
 */
function tokens(part) {
  return (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
}

function operands(part) {
  return tokens(part).filter((token) => !token.startsWith("-"));
}

/**
 * A `>` the shell will act on is a `>` outside quotes. Scanning the raw text instead read
 * `mysql -e "... HAVING COUNT(*) > 1"` as a redirect into a file named `1`, so a read-only
 * SELECT was blocked as a source edit and a fact went unverified on a real run. `psql -c
 * "WHERE n > 5"` and `awk "{ if ($1 > 2) ... }"` are the same sentence.
 *
 * Same lexical rule `tokens` already applies, read left to right: quotes decide whether a
 * character is syntax or data. The operand is read after the operator, so a quoted path
 * (`> "out file.txt"`) still resolves.
 *
 * The regex also required whitespace before the operator, which missed `cat a>b` and
 * `node x.mjs 2> err.log` — both real redirects, both now caught.
 *
 * What this gives up, named rather than claimed away: `sh -c "echo x > path"` was blocked
 * by accident and is now allowed, joining `python -c` and a heredoc into a script on the
 * interpreter ceiling this file already declares.
 */
function operatorPositions(part) {
  return [...unquoted(part)].filter((at) => part[at] === ">" && part[at - 1] !== ">");
}

function operandAt(part, start) {
  let at = start;
  while (part[at] === ">" || part[at] === " " || part[at] === "\t") at += 1;
  const match = REDIRECT_OPERAND.exec(part.slice(at));
  return match ? unquote(match[1]) : null;
}

function redirectTargets(part) {
  return operatorPositions(part)
    .map((at) => operandAt(part, at + 1))
    .filter((target) => target !== null);
}

function copyTargets(part) {
  const tokens = operands(part);
  if (!COPY_VERBS.has(tokens[0])) return [];
  return tokens[0] === "tee" ? tokens.slice(1) : tokens.slice(-1);
}

/**
 * sed's grammar, not a guess: with -e or -f the script rides that flag and every operand
 * is a file; without them the first operand is the script and the rest are files. An
 * earlier version matched only `s/…/…/` and `y/…/…/`, so an append script like `$a\\text`
 * was read as a path and blocked a legitimate edit.
 */
const SED_SCRIPT_FLAGS = new Set(["-e", "-f", "--expression", "--file"]);

function sedTargets(part) {
  if (!SED_IN_PLACE.test(part)) return [];
  const all = tokens(part);
  const files = [];
  let scriptRidesAFlag = false;

  for (let i = 1; i < all.length; i += 1) {
    if (SED_SCRIPT_FLAGS.has(all[i])) {
      scriptRidesAFlag = true;
      i += 1;
    } else if (!all[i].startsWith("-")) {
      files.push(all[i]);
    }
  }
  return scriptRidesAFlag ? files : files.slice(1);
}

/** Every path this command would write to, by the narrow verbs kiln inspects. */
export function writeTargets(command) {
  return segmentsOf(command).flatMap((part) => [
    ...redirectTargets(part),
    ...copyTargets(part),
    ...sedTargets(part),
  ]);
}

/**
 * `rm -rf` and `git clean -xfd` only. Everything else stays with the harness's own
 * permission prompt — the scope D34 deliberately kept narrow.
 */
const REMOVAL = /\b(?:rm|unlink|shred|truncate)\b/;

/**
 * D34 keeps destructive parsing narrow on purpose — `rm -rf` and `git clean -xfd`, and
 * everything else stays with the harness's own prompt. Control files are the exception,
 * because D7 item 7 is not "config.json is hard to edit" but "the agent cannot change the
 * terms it is judged by", and deleting a file is a stronger edit than writing one.
 *
 * Measured on a real run: `rm -f .kiln/config.json` was ALLOWED — as were `rm` without
 * flags and `truncate -s 0` — while `rm -rf` and `mv` onto the same path were blocked.
 * With config gone the dispatcher falls back to a hardcoded `["main", "master"]`, so on a
 * project that ships from `v3-master` the deletion also unprotects the shipping branch.
 */
export function removalTargets(command) {
  return segmentsOf(command).flatMap((part) => (REMOVAL.test(part) ? operands(part).slice(1) : []));
}

export function destructiveTargets(command) {
  return segmentsOf(command).flatMap((part) => {
    if (DESTRUCTIVE_RM.test(part)) return operands(part).slice(1);
    if (GIT_CLEAN.test(part)) return ["."];
    return [];
  });
}

/**
 * D67c, promoted from a reasoned audit item to a law by a production report: stage the
 * run's own files, never a broad commit merely because the tree is dirty. It was a law
 * with no mechanism until here.
 */
const BROAD_STAGE = /\bgit\b[^;|&]*\badd\b[^;|&]*(?:\s-A\b|\s--all\b|\s\.(?:\s|$))/;

export function stagesEverything(command) {
  return segmentsOf(command).some((part) => BROAD_STAGE.test(part));
}

const PR_VERBS = [/\bgh\b[^;|&]*\bpr\b[^;|&]*\bcreate\b/, /\bglab\b[^;|&]*\bmr\b[^;|&]*\bcreate\b/];

/** A command-name match, not a path resolution, so D34's no-shell-parsing line holds. */
export function opensPullRequest(command) {
  return segmentsOf(command).some((part) => PR_VERBS.some((verb) => verb.test(part)));
}
