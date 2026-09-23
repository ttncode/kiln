import { segmentsOf, wordsOf } from "./bash-targets.mjs";

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
const MODULE_FLAG = /^-m$/;

const WRAPPERS = new Set(["sudo", "env", "exec", "xargs", "time", "nohup", "command", "nice"]);
const PIPES = new Set(["|", "|&"]);

/**
 * Only a word in command position is a program being run. `grep node` names node as a
 * pattern, and reading it as an interpreter refused `cat .kiln/config.json | grep node` —
 * a read. Command position is the first word, the first after a pipe, and the first after
 * an assignment or a wrapper like `sudo` or `xargs` and its flags.
 */
function stillAtCommand(word, wrapped) {
  return /^[A-Za-z_]\w*=/.test(word) || WRAPPERS.has(word) || (wrapped && word.startsWith("-"));
}

function interpreterAt(words) {
  let atCommand = true;
  let wrapped = false;
  for (let i = 0; i < words.length; i += 1) {
    if (atCommand && INTERPRETER.test(words[i].split("/").pop())) return i;
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
 * An interpreter reads its program inline when a flag says so, or when nothing follows it
 * but flags — then the program arrives on stdin, from a pipe or a heredoc. A script file or
 * `-m module` is the other case, and that stays the ceiling SECURITY.md names: kiln does not
 * read programs, inline or not, and a file is not a program anybody writes to reach
 * `.kiln/config.json`.
 */
function readsInlineProgram(part) {
  const words = wordsOf(part);
  const at = interpreterAt(words);
  if (at === -1) return false;
  if (words[at] === "deno" && words[at + 1] === "eval") return true;
  for (const word of words.slice(at + 1)) {
    if (INLINE_FLAG.test(word)) return true;
    if (MODULE_FLAG.test(word) || !word.startsWith("-")) return false;
  }
  return fedOnStdin(words.slice(0, at), part);
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
const ENFORCEMENT = [".kiln/config.json", "state.json", ".kiln/rules/", ".kiln/hooks/", ".git/hooks/", ".git/config"];

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
    if (named) return { interpreter: wordsOf(part)[interpreterAt(wordsOf(part))], file: named };
  }
  return null;
}

export function interpreterMessage({ interpreter, file }) {
  return `kiln blocked this ${interpreter} program: it names ${file}, and kiln cannot read what an inline program does.
Files that decide what this run may do are not edited through an interpreter.
Change it with \`kiln config set <key>=<value>\`, or say what needs to change and let the user run it.`;
}
