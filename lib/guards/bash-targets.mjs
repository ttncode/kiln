/**
 * No shell parsing (D34's line holds): no quoting analysis, no subshells, no eval, no
 * interpreters. A token scan catches the verbs a blocked agent actually reaches for —
 * measured in §1.6 finding 11, where the first unprompted retry after a blocked Write
 * was `echo "hello" > <path>`. What stays uncovered is `python -c` and a heredoc into a
 * script, and that residue is the ceiling, named rather than claimed away.
 */
const REDIRECT = /(?:^|\s)>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g;
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
function beforeHeredoc(command) {
  const marker = /<<-?\s*['"]?\w+/.exec(command);
  return marker ? command.slice(0, marker.index) : command;
}

export function segmentsOf(command) {
  return beforeHeredoc(String(command ?? "")).split(/&&|\|\||;|\n/).map((part) => part.trim()).filter(Boolean);
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

function redirectTargets(part) {
  return [...part.matchAll(REDIRECT)].map((match) => unquote(match[1]));
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
