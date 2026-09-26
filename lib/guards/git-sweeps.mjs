import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { argumentsOf, gitCleanTargets } from "./bash-targets.mjs";
import { gitInvocation, gitWorkdirs } from "./git-words.mjs";

/**
 * D204: what a forced `git clean` or a `git stash -u` / `-a` takes with it, answered by git.
 * Neither names a file, so the removal guard never saw them take `.kiln/`: on a fresh init,
 * where kiln's files are untracked until committed (D194), `rm -rf .kiln/hooks` was refused and
 * `git clean -fd` removed it, and `git stash -u` set every guard's config aside. Which paths
 * they reach depends on what is tracked, ignored and excluded, so git's own dry run says — the
 * same listing `git clean -n` and `git stash -u` use — rather than a model of it.
 */

const SWEEP_TIMEOUT_MS = 5000;
const STASH_TAKES_VALUE = new Set(["-m", "--message", "--pathspec-from-file"]);

function gitLines(dir, args) {
  const run = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: SWEEP_TIMEOUT_MS });
  // ponytail: a git that fails or times out here answers "nothing swept"; the command it
  // stands for fails the same way, so a failure removes nothing either.
  return run.status === 0 ? run.stdout.split(/\r?\n/).filter(Boolean) : [];
}

/** `-m msg`, and a cluster ending in `m` (`-um msg`), take the next word as the message. */
function takesValue(token) {
  return STASH_TAKES_VALUE.has(token) || (/^-[^-]/.test(token) && token.endsWith("m"));
}

function shortFlags(token) {
  if (!/^-[^-]/.test(token)) return "";
  const letters = token.slice(1);
  const message = letters.indexOf("m");
  return message === -1 ? letters : letters.slice(0, message);
}

function stashMode(options) {
  const flags = options.filter((token, at) => !takesValue(options[at - 1] ?? ""));
  const has = (letter, long) => flags.some((token) => shortFlags(token).includes(letter) || (token.length >= 5 && long.startsWith(token)));
  if (has("a", "--all")) return "all";
  return has("u", "--include-untracked") ? "untracked" : null;
}

/** `stash`, `stash -u`, `stash push …` push; `save` takes a message, not a pathspec. */
function stashRequest(args) {
  if (args[0] !== "stash") return null;
  const sub = args[1];
  if (sub === "save") return { options: args.slice(2), pathspec: [] };
  const rest = sub === undefined || sub.startsWith("-") ? args.slice(1) : sub === "push" ? args.slice(2) : null;
  if (!rest) return null;
  const end = rest.indexOf("--");
  const options = end === -1 ? rest : rest.slice(0, end);
  const operands = options.filter((token, at) => !token.startsWith("-") && !takesValue(options[at - 1] ?? ""));
  return { options, pathspec: end === -1 ? operands : [...operands, ...rest.slice(end + 1)] };
}

function stashed(dir, args) {
  const request = stashRequest(args);
  const mode = request && stashMode(request.options);
  if (!mode) return [];
  const exclude = mode === "all" ? [] : ["--exclude-standard"];
  return gitLines(dir, ["ls-files", "--others", "--directory", ...exclude, "--", ...request.pathspec]);
}

function cleaned(dir, args) {
  return gitLines(dir, ["clean", "-n", ...args.slice(1)])
    .filter((line) => line.startsWith("Would remove "))
    .map((line) => line.slice("Would remove ".length).replace(/^"(.*)"$/, "$1"));
}

/** Absolute paths the segment's clean or stash would take, run from `cwd`. */
export function sweptPaths(part, cwd) {
  const invocation = gitInvocation(argumentsOf(part));
  if (!invocation) return [];
  const dir = gitWorkdirs(invocation.words).reduce((base, next) => (isAbsolute(next) ? next : join(base, next)), cwd);
  const taken = gitCleanTargets(part) ? cleaned(dir, invocation.args) : stashed(dir, invocation.args);
  return taken.map((path) => resolve(dir, path));
}
