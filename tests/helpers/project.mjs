import { join } from "node:path";
import { DEFAULTS } from "../../lib/config.mjs";
import { hashArtifact, newWork, writeState } from "../../lib/state.mjs";
import { tempRoot, writeConfig, writeFile } from "./fixture.mjs";

export const SESSION = "sess-under-test";

/**
 * A whole .kiln project in one call: config, a work directory, its artifacts, and a
 * gate record whose hash matches the artifact on disk — the shape guards actually read.
 */
export function kilnProject({ path = "bounded", gates = {}, predicted = [], id = "42", sessionId = SESSION } = {}) {
  const root = tempRoot("kiln-project-");
  writeConfig(root, DEFAULTS);
  writeFile(join(root, "src", "app.ts"), "export const a = 1;\n");

  const artifacts = { plan: writeFile(join(root, ".kiln", "work", id, "plan.md"), "# plan\n") };
  writeFile(join(root, ".kiln", "work", id, "brief.md"), "# brief\n");

  const recorded = Object.fromEntries(
    Object.entries(gates).map(([key, decision]) => [key, gateRecord(decision, artifacts[key])]),
  );
  writeState(root, { ...newWork({ id, sessionId, base: "aaaa111", path }), gates: recorded, predicted });
  return { root, id, artifacts, source: join(root, "src", "app.ts") };
}

function gateRecord(decision, artifactPath) {
  return {
    decision,
    artifact_sha: artifactPath ? hashArtifact(artifactPath) : null,
    answer: "yes, approved",
    by: "user",
  };
}

export function payload({ command, file, root, session = SESSION }) {
  const tool_input = command === undefined ? { file_path: file } : { command };
  return { tool_input, cwd: root, session_id: session };
}
