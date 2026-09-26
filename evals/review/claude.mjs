import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

/**
 * One headless Claude Code run, isolated from the machine's own setup: only project settings
 * load (the fixture has none), so no user plugin, hook or CLAUDE.md reaches the reader, and no
 * MCP server is connected. The prompt goes in on stdin. A reader may read and search, and run
 * git's read-only verbs; nothing else.
 */

const READ_ONLY = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git show:*)", "Bash(git log:*)"];
const DENIED = ["Agent", "Task", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];
const TIMEOUT_MS = 15 * 60 * 1000;

function argsFor(run) {
  const args = ["-p", "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--model", run.model];
  args.push("--allowedTools", ...(run.tools ?? READ_ONLY));
  args.push("--disallowedTools", ...DENIED);
  for (const dir of run.addDirs ?? []) args.push("--add-dir", dir);
  if (run.system) args.push("--append-system-prompt", run.system);
  return args;
}

function parsed(stdout, code) {
  try {
    const json = JSON.parse(stdout);
    return { text: json.result ?? "", cost: json.total_cost_usd ?? 0, error: json.is_error ? json.result : null };
  } catch {
    return { text: "", cost: 0, error: `exit ${code}: ${stdout.slice(0, 300)}` };
  }
}

export function runClaude(run) {
  return new Promise((resolve) => {
    const child = spawn("claude", argsFor(run), { cwd: run.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(parsed(stdout, code));
    });
    child.stdin.end(run.prompt);
  });
}
