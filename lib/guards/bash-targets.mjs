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

export function segmentsOf(command) {
  return String(command ?? "").split(/&&|\|\||;|\n/).map((part) => part.trim()).filter(Boolean);
}

function unquote(token) {
  return token.replace(/^["']|["']$/g, "");
}

function operands(part) {
  return part.split(/\s+/).filter(Boolean).filter((token) => !token.startsWith("-")).map(unquote);
}

function redirectTargets(part) {
  return [...part.matchAll(REDIRECT)].map((match) => unquote(match[1]));
}

function copyTargets(part) {
  const tokens = operands(part);
  if (!COPY_VERBS.has(tokens[0])) return [];
  return tokens[0] === "tee" ? tokens.slice(1) : tokens.slice(-1);
}

/** `s/a/b/` is the script, not a file. Resolving it as a path would false-block. */
const SED_SCRIPT = /^[sy]([/|,#]).*\1/;

function sedTargets(part) {
  if (!SED_IN_PLACE.test(part)) return [];
  return operands(part).slice(1).filter((token) => !SED_SCRIPT.test(token));
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
export function destructiveTargets(command) {
  return segmentsOf(command).flatMap((part) => {
    if (DESTRUCTIVE_RM.test(part)) return operands(part).slice(1);
    if (GIT_CLEAN.test(part)) return ["."];
    return [];
  });
}

const PR_VERBS = [/\bgh\b[^;|&]*\bpr\b[^;|&]*\bcreate\b/, /\bglab\b[^;|&]*\bmr\b[^;|&]*\bcreate\b/];

/** A command-name match, not a path resolution, so D34's no-shell-parsing line holds. */
export function opensPullRequest(command) {
  return segmentsOf(command).some((part) => PR_VERBS.some((verb) => verb.test(part)));
}
