/**
 * No shell parsing (D34's line holds): no subshells, no eval, no interpreters. Quotes are
 * read, because which characters are syntax and which are data is a lexical fact the shell
 * settles before any of them run — and reading them wrong is how a SELECT became a write.
 * A token scan catches the verbs a blocked agent actually reaches for —
 * measured in §1.6 finding 11, where the first unprompted retry after a blocked Write
 * was `echo "hello" > <path>`. What stays uncovered is `python -c` and a heredoc into a
 * script, and that residue is the ceiling, named rather than claimed away.
 */
import { homedir } from "node:os";

const REDIRECT_OPERAND = /^("[^"]*"|'[^']*'|[^\s;|&]+)/;
const SED_IN_PLACE = /\bsed\b[^;|&]*\s-i\b/;
const GIT_CLEAN = /\bgit\b[^;|&]*\bclean\b[^;|&]*-[a-z]*[xd][a-z]*f|\bgit\b[^;|&]*\bclean\b[^;|&]*-[a-z]*f[a-z]*[xd]/;

const COPY_VERBS = new Set(["cp", "mv", "tee", "install"]);

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

const HEREDOC_MARKER = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/;

/**
 * One character of the lexer, returning how many it consumed. Quotes decide whether a
 * character is syntax, and a command substitution opens a fresh context even inside double
 * quotes — `"$(cat <<'EOF' … )"` is the form every agent's commit message takes, and its
 * `<<` is one the shell acts on.
 */
function lexChar(lexer, i) {
  const { text } = lexer;
  const ch = text[i];
  if (lexer.quote === "'") {
    if (ch === "'") lexer.quote = null;
    return 1;
  }
  if (ch === "\\") return 2;
  if (text.startsWith("$(", i)) {
    lexer.frames.push(lexer.quote);
    lexer.quote = null;
    return 2;
  }
  if (lexer.quote === '"') {
    if (ch === '"') lexer.quote = null;
    return 1;
  }
  return unquotedChar(lexer, i);
}

function unquotedChar(lexer, i) {
  const ch = lexer.text[i];
  if (ch === '"' || ch === "'") lexer.quote = ch;
  else if (ch === ")" && lexer.frames.length > 0) lexer.quote = lexer.frames.pop();
  else return heredocAt(lexer, i);
  return 1;
}

function heredocAt(lexer, i) {
  const { text } = lexer;
  if (!text.startsWith("<<", i) || text[i + 2] === "<" || text[i - 1] === "<") return 1;
  const marker = HEREDOC_MARKER.exec(text.slice(i));
  if (!marker) return 1;
  lexer.pending.push({ word: marker[3], strip: marker[1] === "-" });
  return marker[0].length;
}

function bodyEnd(text, { from, word, strip }) {
  let at = from;
  for (;;) {
    const end = text.indexOf("\n", at);
    const line = text.slice(at, end === -1 ? text.length : end);
    if ((strip ? line.replace(/^\t+/, "") : line) === word) return end === -1 ? text.length : end + 1;
    if (end === -1) return null;
    at = end + 1;
  }
}

function skipBodies(text, { from, pending }) {
  let at = from;
  for (const marker of pending) {
    at = bodyEnd(text, { from: at, ...marker });
    if (at === null) return null;
  }
  return at;
}

/**
 * A heredoc body is data, not commands, and what follows its terminator is commands again.
 *
 * The body is data: scanning it found `> Recommendation: approve.` inside a plan document
 * and read the markdown blockquote as a redirect, so writing plan.md was blocked for want
 * of the plan gate. The earlier fix cut the command at the first `<<` — and every line
 * after the terminator with it, so `cat > ok <<EOF … EOF` followed by `echo x > /elsewhere`
 * hid the second write completely.
 *
 * A body whose terminator never arrives is judged as written. Guessing where it ends would
 * be guessing which lines the guard gets to read.
 */
export function withoutHeredocBodies(command) {
  const lexer = { text: String(command ?? ""), quote: null, frames: [], pending: [] };
  const { text } = lexer;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\n" && lexer.quote === null && lexer.pending.length > 0) {
      const resume = skipBodies(text, { from: i + 1, pending: lexer.pending });
      if (resume === null) return text;
      out += "\n";
      lexer.pending = [];
      i = resume;
      continue;
    }
    const width = lexChar(lexer, i);
    out += text.slice(i, i + width);
    i += width;
  }
  return out;
}

const SEPARATORS = ["&&", "||", ";", "\n"];

function separatorAt(text, at) {
  return SEPARATORS.find((token) => text.startsWith(token, at)) ?? null;
}

/**
 * Each command of a line with the operator that joined it to the one before. The operator
 * is part of the answer: a `cd` or a branch switch carries across `&&` because the next
 * command runs only if it succeeded, and does not across `||`, which runs because it failed.
 *
 * A separator inside quotes is data, by the same rule that governs `>`. Splitting first and
 * reading quotes afterwards is what broke: `echo "...drop_column('users','email');" > file`
 * split at the `;` in the DDL, so the redirect landed in a fragment that opened with an
 * unterminated quote and the write became invisible.
 */
export function segmentsWithOperators(command) {
  const text = withoutHeredocBodies(command);
  const cuts = [];
  let start = 0;
  for (const at of unquoted(text)) {
    const separator = separatorAt(text, at);
    if (!separator || at < start) continue;
    cuts.push({ part: text.slice(start, at).trim(), next: separator });
    start = at + separator.length;
  }
  cuts.push({ part: text.slice(start).trim(), next: null });
  return withLiteralAssignments(joinedByOperators(cuts));
}

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_]\w*)=("[^"$`]*"|'[^']*'|[^\s"'$`;|&]*)$/;

function expandVariables(part, known) {
  return part.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (match, ...names) => known.get(names[0] ?? names[1]) ?? match);
}

/**
 * A variable set by a literal assignment earlier in the same command line is expanded where
 * it is used, and no other. `W=.kiln/work/<id> && cat > $W/brief.md` is how an agent writes
 * an artifact, and read as a path literally named `$W/brief.md` it was a source edit before
 * the gate — a false block on the investigation itself. The value has to be literal: one
 * holding `$` or a backtick is left unread, which is the ceiling. cc-safety-net resolves
 * paths the same way, from literal assignments only.
 */
function withLiteralAssignments(parts) {
  const known = new Map();
  return parts.map((entry) => {
    const part = expandVariables(entry.part, known);
    const assigned = ASSIGNMENT.exec(part);
    if (assigned) known.set(assigned[1], assigned[2].replace(/^["']|["']$/g, ""));
    return { ...entry, part };
  });
}

/** An empty command between two separators keeps the stronger join: `a &&\n b` is `&&`. */
function joinedByOperators(cuts) {
  const parts = [];
  let operator = null;
  for (const { part, next } of cuts) {
    if (part) parts.push({ part, operator, sequential: operator !== "||" });
    if (part || operator === null || operator === "\n") operator = next;
  }
  return parts;
}

export function segmentsOf(command) {
  return segmentsWithOperators(command).map(({ part }) => part);
}

function unquote(token) {
  return token.replace(/^["']|["']$/g, "");
}

/**
 * `~` and `$HOME` are the two expansions whose value kiln can know without running
 * anything, and `rm -rf ~/data` is the example this guard was written for. Resolved as a
 * relative path it landed inside the project as a directory literally named `~`, and the
 * command was allowed. Every other variable stays unread: that is the ceiling.
 */
function expandHome(token) {
  const home = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(token);
  return home ? `${homedir()}${token.slice(home[0].length)}` : token;
}

/**
 * A quoted run is one token. That is a lexical rule, not a parse — D34's line is about
 * not interpreting a shell, and splitting `'$a\\// a'` into two arguments misreads what
 * the shell will pass, which is how a sed script became two phantom paths.
 */
export function wordsOf(part) {
  return (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
}

const REDIRECTION = /^\d*(?:<<?<?|>>?|&>>?|>&|<&)/;

/**
 * The arguments a command actually receives. A redirection is not one of them — `tee file
 * < /dev/null` named `/dev/null` as a second file to write, and `<<EOF` became a path.
 */
function argumentsOf(part) {
  const words = wordsOf(part);
  const args = [];
  for (let i = 0; i < words.length; i += 1) {
    const redirect = REDIRECTION.exec(words[i]);
    if (!redirect) args.push(words[i]);
    else if (redirect[0] === words[i]) i += 1;
  }
  return args;
}

function operands(part) {
  return argumentsOf(part).filter((token) => !token.startsWith("-")).map(expandHome);
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
  return match ? expandHome(unquote(match[1])) : null;
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
  const all = argumentsOf(part).map(expandHome);
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
 * Verbs that take a file away from where it was, or take away the right to read it.
 * `chmod 000` on a work directory was the quietest of them: the guard could no longer read
 * the state inside and treated the work as not there.
 */
const REMOVAL = /\b(?:rm|unlink|shred|truncate|chmod|chown|chattr)\b/;

/**
 * `mv` removes its sources as surely as `rm` does. Only the destination was ever checked,
 * so `mv .kiln/work/<id>/state.json old.md` took the gate record away and the next source
 * edit found no work to hold it to. cc-safety-net protects its own policy file the same
 * way: a `mv` whose *source* is the file, or an ancestor of it.
 */
function movedAway(part) {
  const args = operands(part);
  if (args[0] === "mv") return args.slice(1, -1);
  if (args[0] === "git" && args[1] === "mv") return args.slice(2, -1);
  return [];
}

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
  return segmentsOf(command).flatMap((part) => [
    ...(REMOVAL.test(part) ? operands(part).slice(1) : []),
    ...movedAway(part),
  ]);
}

/**
 * Read as tokens, the way rm reads them: `-r` or `-R` anywhere in a short cluster, and
 * `--recursive` by any prefix git-style option parsing accepts. The regex it replaces saw
 * lowercase short flags only, so `rm -Rf` and `rm --recursive --force` both walked past it.
 *
 * `-f` is no longer required. It only silences prompts; `rm -r` removes the same tree, and
 * dcg refuses a recursive remove without it for that reason.
 */
function recursiveRemoval(part) {
  const args = argumentsOf(part);
  const at = args.indexOf("rm");
  if (at === -1) return null;
  const rest = args.slice(at + 1);
  const end = rest.indexOf("--");
  const flags = end === -1 ? rest : rest.slice(0, end);
  const recursive = flags.some((token) => /^-[a-zA-Z]*[rR]/.test(token) || (token.length >= 3 && "--recursive".startsWith(token)));
  if (!recursive) return null;
  const targets = end === -1 ? flags.filter((token) => !token.startsWith("-")) : [...flags.filter((token) => !token.startsWith("-")), ...rest.slice(end + 1)];
  return targets.map(expandHome);
}

export function destructiveTargets(command) {
  return segmentsOf(command).flatMap((part) => {
    const removed = recursiveRemoval(part);
    if (removed) return removed;
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
