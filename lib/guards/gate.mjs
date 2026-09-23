import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { AUTHORIZING, SHIP_AUTHORIZING, hashArtifact } from "./../state.mjs";
import { isInside } from "./../paths.mjs";

const ARTIFACT = /\.md$/;

function artifactFor(root, { state, key }) {
  const name = key === "review" ? "review.md" : `${key === "probe" ? "brief" : key}.md`;
  return join(root, ".kiln", "work", state.id, name);
}

/** Investigation notes precede every gate, so writing them is always allowed. */
export function isArtifact(root, { target, activeId }) {
  const dir = join(root, ".kiln", "work", activeId ?? "");
  return Boolean(activeId) && isInside(dir, target) && ARTIFACT.test(target.split(sep).pop());
}

/**
 * D19 listed three allowed writes: project source, `.kiln/work/<active-id>/`, and
 * `.kiln/tmp/<active-id>/`. The third was never implemented, so scratch space was judged as
 * source and needed the plan gate — and the plan gate is exactly what the agent has not got
 * yet while it is investigating.
 *
 * Measured: every path an agent might put a temp file in was refused before the plan gate.
 * The harness's own scratchpad is outside the project root, so the sandbox refuses it; the
 * repository refuses it because no gate authorises source; and `.kiln/tmp/` refused it for
 * the same reason. Nowhere to write, and no message naming anywhere.
 *
 * No extension filter, unlike an artifact: scratch is scratch. Scoped to the active work for
 * the same reason `work/<id>/` is — another run's step logs are its evidence, not this run's
 * to overwrite.
 *
 * This does not widen the interpreter ceiling B25 names. An agent that wants to run a program
 * kiln cannot read does not need a file to do it; `bash -c` was always there.
 */
export function isScratch(root, { target, activeId }) {
  return Boolean(activeId) && isInside(join(root, ".kiln", "tmp", activeId), target);
}

/**
 * The hash is what makes approval bind to the document the user actually read. It is
 * checked on every gate key, not only the one that authorizes source edits, and it
 * cannot reach across a pass boundary — there the artifact is unchanged and that is
 * precisely the failure, which is why openNextPass clears the records instead (D85).
 */
export function gateStillBinds(root, { state, key }) {
  const record = state.gates?.[key];
  if (!record || record.decision !== "approved") return { ok: false, reason: `the ${key} gate is not approved` };
  if (!record.artifact_sha) return { ok: true };

  const path = artifactFor(root, { state, key });
  if (!existsSync(path)) return { ok: false, reason: `${key}.md is gone, but its approval is still on record` };
  if (hashArtifact(path) !== record.artifact_sha) {
    return { ok: false, reason: `${key}.md changed after it was approved` };
  }
  return { ok: true };
}

const REVIEWED = `this work passed its review gate, so a change now would ship unreviewed. If VERIFY failed, \`kiln verify\` has recorded it and reopened implementation; otherwise the change belongs in a new work`;

/**
 * No active work means kiln is not driving this session, and kiln does not police
 * sessions it is not driving (D33). That branch is proven, not assumed: the guard knows
 * there is nothing to protect.
 */
export function sourceEditVerdict(root, { state, target }) {
  if (!state) return { blocked: false };
  if (state.status === "halted") return { blocked: true, reason: "this work is halted" };
  if (isArtifact(root, { target, activeId: state.id })) return { blocked: false };
  if (isScratch(root, { target, activeId: state.id })) return { blocked: false };
  if (state.status === "reviewed") return { blocked: true, reason: REVIEWED };

  const key = AUTHORIZING[state.path];
  if (!key) return { blocked: true, reason: `unknown ceremony path: ${state.path}` };
  const binding = gateStillBinds(root, { state, key });
  return binding.ok ? { blocked: false } : { blocked: true, reason: binding.reason };
}

/** `null` means no gate can authorize it, which is how a spike is kept from shipping. */
export function shipVerdict(root, state) {
  if (!state) return { blocked: false };
  const key = SHIP_AUTHORIZING[state.path];
  if (key === null) return { blocked: true, reason: `a ${state.path} does not ship — ratchet up first` };
  if (key === undefined) return { blocked: true, reason: `unknown ceremony path: ${state.path}` };

  const binding = gateStillBinds(root, { state, key });
  return binding.ok ? { blocked: false } : { blocked: true, reason: binding.reason };
}

export function gateMessage(action, reason) {
  return `kiln blocked ${action}: ${reason}.
Go back to the gate. The block is the message, not an obstacle to route around.`;
}
