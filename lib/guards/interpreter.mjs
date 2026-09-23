import { heredocBodiesOf, segmentsOf, wordsOf } from "./bash-targets.mjs";

/**
 * D34 keeps kiln out of the business of interpreting a shell, and an inline program handed
 * to another language is a second interpreter behind the first. kiln cannot read it, and
 * house-rules #58 is the standing argument against trying: a command-text scan can never be
 * finished.
 *
 * So this does not read the program. It reads whether the program mentions a file kiln's
 * enforcement is made of — and refuses on that alone, because "kiln cannot see what this
 * does" and "this is allowed near the files kiln is judged by" cannot both hold.
 *
 * Measured: an agent repaired a config kiln had corrupted with
 *
 *     node -e "const fs=require('fs'); ... .kiln/config.json ..."
 *
 * and it was allowed. D48 is not "config.json is hard to edit" — it is that the agent cannot
 * change the terms it is judged by, and an interpreter walked straight past it.
 */
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|node|nodejs|deno|bun|python[0-9.]*|perl|ruby|php|lua|osascript)$/;

/**
 * The spellings that hand an interpreter its program inline rather than as a file. Listing
 * `-c`, `-e` and `-r` and stopping there is dcg #425 exactly: `node -p`, `node --eval` and
 * `perl -E` walked past guards that knew only the short form.
 */
const INLINE_FLAG = /^(?:-[a-zA-Z]*[cepEr]|--(?:eval|print|command)(?:=.*)?|-)$/;

const WRAPPERS = new Set(["sudo", "env", "exec", "xargs", "time", "nohup", "command", "nice"]);
const PIPES = new Set(["|", "|&"]);

/**
 * The interpreter word itself, with whatever opens a group or a substitution in front of it
 * — `(python3`, `$(python3`, `{`, `!` — taken off, and a path reduced to its name.
 */
function nameOf(word) {
  return word.replace(/^(?:\$\(|[({!`])+/, "").split("/").pop();
}

function isInterpreter(word) {
  return INTERPRETER.test(nameOf(word));
}

/**
 * Only a word in command position is a program waiting on stdin. `grep node` names node as a
 * pattern, and reading it as an interpreter refused `cat .kiln/config.json | grep node` — a
 * read. Command position is the first word, the first after a pipe, and the first after an
 * assignment or a wrapper like `sudo` or `xargs` and its flags.
 */
function stillAtCommand(word, wrapped) {
  return /^[A-Za-z_]\w*=/.test(word) || WRAPPERS.has(word) || (wrapped && word.startsWith("-"));
}

function interpreterAt(words) {
  let atCommand = true;
  let wrapped = false;
  for (let i = 0; i < words.length; i += 1) {
    if (atCommand && isInterpreter(words[i])) return i;
    if (PIPES.has(words[i])) {
      [atCommand, wrapped] = [true, false];
    } else {
      atCommand = atCommand && stillAtCommand(words[i], wrapped);
      wrapped = wrapped || WRAPPERS.has(words[i]);
    }
  }
  return -1;
}

/**
 * A program handed inline. The flag is looked for anywhere after the interpreter word, and
 * the interpreter anywhere in the segment: stopping at the first non-flag word, or reading
 * only a simple command position, let `python3 -W ignore -c …`, `timeout 5 python3 -c …`,
 * `(python3 -c …)`, `if python3 -c …` and `uv run python -c …` all through while each wrote
 * the config. A program on stdin is the narrower case, below, and keeps command position.
 */
function readsInlineProgram(part) {
  const words = wordsOf(part);
  const flagged = words.some((word, at) => isInterpreter(word) && inlineFlagAfter(words, at));
  if (flagged) return true;
  const at = interpreterAt(words);
  if (at === -1) return false;
  const named = words.slice(at + 1).some((word) => !word.startsWith("-") && !PIPES.has(word) && !/^\d*[<>]/.test(word));
  return !named && fedOnStdin(words.slice(0, at), part);
}

function inlineFlagAfter(words, at) {
  if (nameOf(words[at]) === "deno" && words[at + 1] === "eval") return true;
  return words.slice(at + 1).some((word) => INLINE_FLAG.test(word));
}

/**
 * With no program named, an interpreter runs what arrives on stdin — but only when something
 * sends it there: a pipe into it, a heredoc, a `<`. `node --version` sends nothing, and read
 * as a program waiting on stdin it was refused on a real run beside an unrelated `cat` of the
 * config.
 */
function fedOnStdin(before, part) {
  return before.some((word) => PIPES.has(word)) || /<</.test(part) || /(?:^|\s)<\s*\S/.test(part);
}

/**
 * The files that decide what a run is allowed to do, by name rather than by resolved path.
 *
 * `.kiln/rules/` is here unconditionally while the sandbox blocks it only during a run: an
 * inline program is not how anybody writes a markdown rule, and it is how the one path the
 * sandbox cannot see would delete one.
 */
const ENFORCEMENT = [".kiln/config.json", "state.json", ".kiln/work", ".kiln/rules/", ".kiln/hooks/", ".git/hooks/", ".git/config"];

/**
 * The heredoc body is searched when the program reads one: `python3 - <<EOF` carries its
 * program there, which is exactly the part every other scan here skips as data.
 */
export function interpreterReach(command) {
  const text = String(command ?? "");
  for (const part of segmentsOf(text).filter(readsInlineProgram)) {
    // The program is the segment, plus the heredoc body it reads when it has one; a `cat` of
    // the config in another segment of the same line is not part of it.
    const program = /<</.test(part) ? text : part;
    const named = ENFORCEMENT.find((file) => program.includes(file));
    if (named) return { interpreter: nameOf(wordsOf(part).find(isInterpreter)), file: named };
  }
  return null;
}

const SHELL = /^(?:sh|bash|zsh|dash|ksh)$/;

/**
 * The shell programs inside a command: `bash -c "<program>"`, and a heredoc fed to a shell.
 * Each is a command line in its own right, and every guard has to read it as one — a body
 * fed to `bash` was dropped as data, so `bash <<EOF` around `git commit --no-verify` hid the
 * commit from the guard that refuses it.
 */
export function shellPrograms(command) {
  const text = String(command ?? "");
  const programs = segmentsOf(text).flatMap((part) => {
    const words = wordsOf(part);
    const at = words.findIndex((word) => SHELL.test(nameOf(word)));
    if (at === -1) return [];
    const flag = words.findIndex((word, index) => index > at && /^-[a-zA-Z]*c$/.test(word));
    return flag === -1 || !words[flag + 1] ? [] : [words[flag + 1]];
  });
  const feedsShell = segmentsOf(text).some((part) => /<</.test(part) && interpreterAt(wordsOf(part)) !== -1 && SHELL.test(nameOf(wordsOf(part)[interpreterAt(wordsOf(part))])));
  return feedsShell ? [...programs, ...heredocBodiesOf(text)] : programs;
}

export function interpreterMessage({ interpreter, file }) {
  return `kiln blocked this ${interpreter} program: it names ${file}, and kiln cannot read what an inline program does.
Files that decide what this run may do are not edited through an interpreter.
Change it with \`kiln config set <key>=<value>\`, or say what needs to change and let the user run it.`;
}
