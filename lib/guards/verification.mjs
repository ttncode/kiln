import { sep } from "node:path";

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
const ENV_OVERRIDES = /\b(?:GIT_CONFIG_COUNT|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM)=/;
const HOOKS_PATH = /core\.hookspath/i;

/** `-n` is `--no-verify` for commit and `--dry-run` for push. Measured both ways. */
const SHORT_NO_VERIFY = new Set(["commit"]);

function segmentsOf(command) {
  return command.split(/&&|\|\||;|\n/).map((part) => part.trim()).filter(Boolean);
}

function tokenize(part) {
  return part.split(/\s+/).filter(Boolean);
}

function gitArgs(tokens) {
  const start = tokens.indexOf("git");
  return start === -1 ? null : tokens.slice(start + 1);
}

function subcommandOf(args) {
  return args.find((token) => !token.startsWith("-") && !args[args.indexOf(token) - 1]?.match(/^-[cC]$/));
}

function disarmIn(part) {
  if (ENV_OVERRIDES.test(part)) {
    return { how: "an environment variable that redirects git's own config", fix: "run git without it" };
  }
  const tokens = tokenize(part);
  const args = gitArgs(tokens);
  if (!args) return null;

  if (args.some((token) => HOOKS_PATH.test(token))) {
    return { how: "core.hooksPath, which points git's hooks somewhere else", fix: "leave the project's hooks where they are" };
  }
  if (args.includes("--no-verify")) {
    return { how: "--no-verify, which skips the repository's own hooks", fix: "fix what the hook reports, or say why it should not run" };
  }
  if (args.includes("-n") && SHORT_NO_VERIFY.has(subcommandOf(args))) {
    return { how: "-n, which is --no-verify for this command", fix: "fix what the hook reports, or say why it should not run" };
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
 */
export function isVerificationFile(target) {
  const parts = target.split(sep);
  const git = parts.lastIndexOf(".git");
  if (git === -1) return false;
  const rest = parts.slice(git + 1);
  return rest[0] === "hooks" || (rest.length === 1 && rest[0] === "config");
}
