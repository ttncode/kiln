import { basename } from "node:path";

/**
 * D200: the git invocation a shell segment runs, found the way the shell finds it. The guards
 * compared the segment's first word with `git`, so `sudo git push origin main`, `FOO=1 git …`,
 * `/usr/bin/git …`, `\git …`, `(git …)` and `git -c alias.p=push p origin main` pushed to a
 * protected branch. destructive_command_guard (normalize.rs) and cc-safety-net
 * (transparent-wrappers.ts) strip the same wrappers before judging; aliases given on the
 * command line are expanded, as both do, and a `!` alias is a shell command judged as one.
 */

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Each wrapper, and the options of its own that take a value, so the value is skipped too. */
const WRAPPERS = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--prompt"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  nohup: new Set(),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
};

/** `timeout` takes its duration as the first operand, not as an option. */
const LEADING_OPERANDS = { timeout: 1 };

const GLOBAL_FLAGS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

function isGit(word) {
  const bare = word.replace(/^\\/, "");
  return bare === "git" || basename(bare).toLowerCase() === "git" || basename(bare).toLowerCase() === "git.exe";
}

/** D205: `git-checkout …` is the dashed form of `git checkout …`, still installed in git's exec-path. */
const DASHED = /^git-([a-z][a-z-]*)$/;

function asGit(word) {
  if (isGit(word)) return ["git"];
  const dashed = DASHED.exec(basename(word.replace(/^\\/, "")));
  return dashed ? ["git", dashed[1]] : null;
}

function skipWrapperOptions(tokens, { at, takesValue }) {
  let index = at;
  while (index < tokens.length && (tokens[index].startsWith("-") || ASSIGNMENT.test(tokens[index]))) {
    index += takesValue.has(tokens[index]) ? 2 : 1;
  }
  return index;
}

/** Past assignments and wrappers to the word the shell runs, or -1 when none is left. */
function commandWordIndex(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const word = tokens[index];
    if (ASSIGNMENT.test(word)) index += 1;
    else if (WRAPPERS[word]) index = skipWrapperOptions(tokens, { at: index + 1, takesValue: WRAPPERS[word] }) + (LEADING_OPERANDS[word] ?? 0);
    else return index;
  }
  return -1;
}

function unwrapGrouping(tokens) {
  const words = [...tokens];
  while (words.length > 0 && /^[({]+$/.test(words[0])) words.shift();
  if (words.length > 0) words[0] = words[0].replace(/^[({]+/, "");
  if (words.length > 0) words[words.length - 1] = words[words.length - 1].replace(/[)}]+;?$/, "");
  return words.filter(Boolean);
}

/** `-c alias.<name>=<value>` pairs given on this command line. */
function aliasesIn(tokens) {
  const aliases = new Map();
  tokens.forEach((token, at) => {
    const match = tokens[at - 1] === "-c" ? /^alias\.([^=]+)=(.*)$/.exec(token) : null;
    if (match) aliases.set(match[1], match[2]);
  });
  return aliases;
}

function afterGlobalFlags(tokens) {
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    index += GLOBAL_FLAGS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
  }
  return index;
}

/**
 * `{ words, args, shell }`: the invocation as `git …` with any wrapper gone, the arguments
 * after git's own global options with a command-line alias expanded, and — for a `!` alias —
 * the shell command it runs instead. `null` when the segment does not run git.
 */
export function gitInvocation(tokens) {
  const words = unwrapGrouping(tokens);
  const at = commandWordIndex(words);
  const git = at === -1 ? null : asGit(words[at]);
  if (!git) return null;
  const invocation = [...git, ...words.slice(at + 1)];
  const start = afterGlobalFlags(invocation);
  const [name, ...rest] = invocation.slice(start);
  const alias = aliasesIn(invocation.slice(0, start)).get(name);
  if (alias === undefined) return { words: invocation, args: invocation.slice(start), shell: null };
  if (alias.startsWith("!")) return { words: invocation, args: [], shell: `${alias.slice(1)} ${rest.join(" ")}`.trim() };
  return { words: invocation, args: [...alias.split(/\s+/).filter(Boolean), ...rest], shell: null };
}

/** The value of each `-C` before the subcommand, in order: where git will run. */
export function gitWorkdirs(words) {
  const dirs = [];
  for (let at = 1; at < words.length && words[at].startsWith("-"); at += GLOBAL_FLAGS_WITH_VALUE.has(words[at]) ? 2 : 1) {
    if (words[at] === "-C" && words[at + 1]) dirs.push(words[at + 1]);
  }
  return dirs;
}
