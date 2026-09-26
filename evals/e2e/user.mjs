import { spawn } from "node:child_process";

/**
 * The person on the other side of the session. It sees only what a user sees — the assistant's
 * last message — and answers as the developer who asked for the work. It cannot read the code,
 * and it never approves with the vague words kiln refuses ("sounds good", "up to you").
 */

function simulatorPrompt({ persona, ticket, message }) {
  return `${persona}

You asked Claude Code, with the kiln plugin, for this:
${ticket}

Its last message to you is below. Reply as yourself, in one to three sentences, as you would type it.
- When it shows a plan, a spec, a review or a gate and it matches what you asked, approve it plainly, e.g. "Yes, approve."
- When it offers numbered options, pick the one that matches what you want; take the one marked recommended only when it does not contradict it, and write that option's words.
- When it asks a question, answer it from what you want; if you do not know, say what you would decide.
- Never answer with "sounds good", "whatever you think", "sure" or "up to you".
- If the message says the work is finished, shipped, answered, or that it cannot go on without something you cannot give, reply with exactly: DONE

Its last message:
---
${message}
---`;
}

export function userReply({ scenario, message, model }) {
  return new Promise((resolve) => {
    const args = ["-p", "--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence", "--model", model, "--output-format", "json", "--disallowedTools", "Bash", "Edit", "Write", "Read", "Agent", "Task", "WebFetch", "WebSearch"];
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout).result.trim());
      } catch {
        resolve("DONE");
      }
    });
    child.stdin.end(simulatorPrompt({ persona: scenario.persona, ticket: scenario.ticket, message }));
  });
}
