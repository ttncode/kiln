import { segmentsOf } from "./bash-targets.mjs";

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
const INLINE_PROGRAM = /\b(?:sh|bash|zsh|node|deno|bun|python|python3|perl|ruby|php)\b[^;|&]*\s-(?:c|e|r)\b/;

/**
 * The files that decide what a run is allowed to do, by name rather than by resolved path.
 *
 * `.kiln/rules/` is here unconditionally while the sandbox blocks it only during a run: an
 * inline program is not how anybody writes a markdown rule, and it is how the one path the
 * sandbox cannot see would delete one.
 */
const ENFORCEMENT = [".kiln/config.json", "state.json", ".kiln/rules/", ".kiln/hooks/", ".git/hooks/", ".git/config"];

export function interpreterReach(command) {
  for (const part of segmentsOf(command)) {
    if (!INLINE_PROGRAM.test(part)) continue;
    const named = ENFORCEMENT.find((file) => part.includes(file));
    if (named) return { interpreter: part.trim().split(/\s+/)[0], file: named };
  }
  return null;
}

export function interpreterMessage({ interpreter, file }) {
  return `kiln blocked this ${interpreter} program: it names ${file}, and kiln cannot read what an inline program does.
Files that decide what this run may do are not edited through an interpreter.
Change it with \`kiln config set <key>=<value>\`, or say what needs to change and let the user run it.`;
}
