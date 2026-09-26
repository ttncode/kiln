import { argumentsOf, segmentsOf } from "./bash-targets.mjs";
import { gitInvocation } from "./git-words.mjs";

/**
 * D206: SHIP is a run's one commit point (D142), and it was prose. A commit before the
 * ship-authorising gate puts unreviewed or unverified work into history under the work's
 * name, and `git commit -a` at SHIP commits whatever else is tracked and dirty (D67c).
 */

/** Short options of `git commit` whose value follows: a letter after one of these is the value. */
const VALUED = "mFCct";

function clusterLetters(token) {
  if (!/^-[^-]/.test(token)) return "";
  const letters = token.slice(1);
  const at = [...letters].findIndex((letter) => VALUED.includes(letter));
  return at === -1 ? letters : letters.slice(0, at + 1);
}

const LONG_VALUED = new Set(["--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--cleanup", "--trailer"]);

/** A word is a value when the option before it takes one and did not attach it. */
function isValue(previous = "") {
  const letters = clusterLetters(previous);
  return (letters !== "" && letters === previous.slice(1) && VALUED.includes(letters.at(-1))) || LONG_VALUED.has(previous);
}

function commitsAll(args) {
  return args.some((token, at) => !isValue(args[at - 1]) && (clusterLetters(token).includes("a") || (token.length >= 4 && "--all".startsWith(token))));
}

/** `{ all }` for the first `git commit` in the command, or `null` when it runs none. */
export function commitIn(command) {
  for (const part of segmentsOf(command)) {
    const invocation = gitInvocation(argumentsOf(part));
    if (invocation?.args[0] === "commit") return { all: commitsAll(invocation.args.slice(1)) };
  }
  return null;
}
