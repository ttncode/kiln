import { spawnSync } from "node:child_process";

/**
 * PostToolUse runs after the write lands, so this cannot prevent anything — it reports.
 * When php is not installed there is nothing to report from, and saying so by returning
 * null is not the fail-open D33 forbids: that law governs guards that stand between an
 * action and its consequence, and a lint that runs afterwards is not one.
 */
function phpAvailable() {
  return spawnSync("php", ["--version"], { stdio: "ignore" }).status === 0;
}

export function check(payload) {
  const path = payload.tool_input?.file_path;
  if (!path || !path.endsWith(".php") || !phpAvailable()) return null;

  const result = spawnSync("php", ["-l", path], { encoding: "utf8" });
  if (result.status === 0) return null;
  return { blocked: true, reason: `php -l rejected ${path}:\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
