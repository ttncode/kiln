import { sep } from "node:path";
import { segmentsOf, wordsOf } from "./bash-targets.mjs";

/**
 * Git's own hooks are the only layer that sees a command *after* git has resolved which
 * checkout, which branch and which config were in play — the four runtime classes no scan
 * of a command line can reach. That makes them worth having, and it makes the ways to
 * switch them off worth watching: a floor nobody guards is decoration.
 *
 * This guard is deliberately the easy half of the problem. Inferring runtime state from a
 * string is unreliable; matching a literal flag is not, and the set of flags is finite and
 * documented. That division is the one house-rules arrived at after hardening a text scan
 * to 1437 lines and watching it fall anyway.
 *
 * Every entry below was measured, not read: with a failing hook installed, each one let
 * the operation through.
 */
const ENV_OVERRIDES = /\b(?:GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM)=|\b(?:HUSKY|LEFTHOOK)=0\b/;
const HOOKS_PATH = /core\.hookspath/i;

/**
 * git accepts any unambiguous prefix of a long option (gitcli(7)), so `--no-verif` is
 * `--no-verify` to git and was nothing to this guard — measured with a failing hook
 * installed, the push went through. An ambiguous prefix makes git refuse the command on its
 * own, so matching every prefix from `--no-v` costs nothing.
 */
const NO_VERIFY = "--no-verify";
const SHORTEST_PREFIX = "--no-v".length;

function isNoVerify(token) {
  const option = token.split("=")[0];
  return option.length >= SHORTEST_PREFIX && NO_VERIFY.startsWith(option);
}

/**
 * `-n` is `--no-verify` for commit and `--dry-run` for push. Measured both ways. Short flags
 * cluster (`-anm`), and a letter that takes a value ends the cluster — the rest of the token
 * is that value, which is why `-mn` is the message "n" and not a skipped hook.
 */
const SHORT_NO_VERIFY = new Set(["commit"]);
const TAKES_VALUE = new Set(["m", "F", "c", "C", "t"]);
const OPTIONAL_ATTACHED = new Set(["S", "u"]);

function clusterSkipsHooks(token) {
  if (!/^-[A-Za-z]+$/.test(token)) return false;
  for (const letter of token.slice(1)) {
    if (letter === "n") return true;
    if (TAKES_VALUE.has(letter) || OPTIONAL_ATTACHED.has(letter)) return false;
  }
  return false;
}

/**
 * `-S` and `-u` take a value only when it is attached (`-Skey`, `-uno`); a separate word after
 * them is the next option. Skipping it as their value hid `git commit -u -n` from this guard,
 * and a real commit then ran with its hook skipped.
 */
function shortNoVerify(args) {
  for (let i = 1; i < args.length; i += 1) {
    if (clusterSkipsHooks(args[i])) return true;
    if (/^-[A-Za-z]*$/.test(args[i]) && TAKES_VALUE.has(args[i].slice(-1))) i += 1;
  }
  return false;
}

function gitArgs(words) {
  const start = words.indexOf("git");
  return start === -1 ? null : words.slice(start + 1);
}

const GLOBAL_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** The first word that is not a global option or its separate value — `git --git-dir .git commit` is a commit. */
function subcommandOf(args) {
  return args.find((token, index) => !token.startsWith("-") && !GLOBAL_WITH_VALUE.has(args[index - 1] ?? ""));
}

const SKIPS_HOOKS = { how: "--no-verify, which skips the repository's own hooks", fix: "fix what the hook reports, or say why it should not run" };

function disarmIn(part) {
  if (ENV_OVERRIDES.test(part)) {
    return { how: "an environment variable that redirects or switches off git's own hooks", fix: "run git without it" };
  }
  const args = gitArgs(wordsOf(part));
  if (!args) return null;
  if (args.some((token) => HOOKS_PATH.test(token))) {
    return { how: "core.hooksPath, which points git's hooks somewhere else", fix: "leave the project's hooks where they are" };
  }
  if (args.some(isNoVerify)) return SKIPS_HOOKS;
  const subcommand = subcommandOf(args);
  if (SHORT_NO_VERIFY.has(subcommand) && shortNoVerify(args.slice(args.indexOf(subcommand)))) {
    return { how: "-n, which is --no-verify for this command", fix: SKIPS_HOOKS.fix };
  }
  return null;
}

/** Null when nothing in the command switches verification off. */
export function disarmAttempt(command) {
  if (!command) return null;
  for (const part of segmentsOf(command)) {
    const found = disarmIn(part);
    if (found) return found;
  }
  return null;
}

export function disarmMessage({ how, fix }) {
  return `kiln blocked this command: it turns off verification — ${how}.
A check you switch off is not a check. ${fix[0].toUpperCase()}${fix.slice(1)}.`;
}

/**
 * The files that *are* the verification layer. `.git/` sits inside the project root, so
 * the sandbox allows writes to it; a hook you can delete is a hook that stops at the first
 * `rm`. Measured: `rm -f .git/hooks/pre-push` was ALLOWED, and the push then went through.
 *
 * A submodule keeps its hooks and config under the superproject's `.git/modules/<name>/`,
 * and the floor is installed in every checkout (D90) — so `.git/hooks` alone protected the
 * floor of exactly one of them. `.husky/` is where a husky project keeps the hooks git runs.
 */
export function isVerificationFile(target) {
  const parts = target.split(sep);
  const kiln = parts.lastIndexOf(".kiln");
  if (kiln !== -1 && parts[kiln + 1] === "hooks") return true;
  if (parts.includes(".husky")) return true;
  const git = parts.lastIndexOf(".git");
  if (git === -1) return false;
  const rest = parts.slice(git + 1);
  if (rest.includes("hooks")) return true;
  return rest[rest.length - 1] === "config" && (rest.length === 1 || rest[rest.length - 3] === "modules");
}
