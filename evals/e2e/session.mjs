import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { clearTimeout, setTimeout } from "node:timers";

/**
 * One turn of a real Claude Code session with kiln loaded from a checkout, as a user would run
 * it — except that only kiln is loaded (no other plugin, hook or CLAUDE.md of this machine), and
 * permissions are bypassed because the project is a throwaway copy with no secrets in it.
 * kiln's own hooks still run: they are what is being tested.
 */

const TURN_TIMEOUT_MS = 60 * 60 * 1000;

function argsFor(turn) {
  const args = ["-p", "--plugin-dir", turn.kiln, "--setting-sources", "project", "--strict-mcp-config", "--model", turn.model, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "--max-budget-usd", String(turn.budget)];
  if (turn.resume) args.push("--resume", turn.resume);
  return args;
}

/** The session id, the assistant's last text and the cost, read from the stream as it arrives. */
function reader(transcript) {
  const seen = { sessionId: null, lastText: "", cost: 0, toolUses: [] };
  let buffer = "";
  const onData = (chunk) => {
    appendFileSync(transcript, chunk);
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) absorb(seen, line);
  };
  return { seen, onData };
}

function parsed(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function absorbAssistant(seen, content) {
  for (const part of content) {
    if (part.type === "text") seen.lastText = part.text;
    if (part.type === "tool_use") seen.toolUses.push({ name: part.name, input: part.input });
  }
}

function absorb(seen, line) {
  const event = parsed(line);
  if (!event) return;
  if (event.session_id) seen.sessionId = event.session_id;
  // A resumed session reports its running total on every result, so the highest one is its cost.
  if (event.type === "result") seen.cost = Math.max(seen.cost, event.total_cost_usd ?? 0);
  if (event.type === "assistant") absorbAssistant(seen, event.message?.content ?? []);
}

export function runTurn(turn) {
  return new Promise((resolve) => {
    const child = spawn("claude", argsFor(turn), { cwd: turn.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const { seen, onData } = reader(turn.transcript);
    const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", onData);
    child.stderr.setEncoding("utf8").on("data", (chunk) => appendFileSync(`${turn.transcript}.stderr`, chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ...seen, code });
    });
    child.stdin.end(turn.prompt);
  });
}
