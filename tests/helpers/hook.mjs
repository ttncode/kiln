import { spawnSync } from "node:child_process";
import { dispatch } from "../../hooks/dispatch.mjs";

const DISPATCH = new URL("../../hooks/dispatch.mjs", import.meta.url).pathname;

/**
 * The production entry point, called in process, with the message it wrote. Asserting the
 * exit code alone let a guard block for the wrong reason and still pass; cc-safety-net and
 * dcg both assert the reason beside the verdict, and so does every case built on this.
 */
export async function judge(phase, payload) {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => written.push(String(chunk)) && true;
  try {
    const status = await dispatch(phase, payload);
    return { status, stderr: written.join("") };
  } finally {
    process.stderr.write = original;
  }
}

/**
 * The hook as the harness runs it: a separate process, JSON on stdin, the exit code as the
 * verdict. `KILN_ROOT` is dropped so the caller's own environment cannot aim the guard at
 * a different project than the payload names.
 */
export function spawnHook(phase, input) {
  const env = { ...process.env };
  delete env.KILN_ROOT;
  const run = spawnSync(process.execPath, [DISPATCH, phase], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env,
  });
  return { status: run.status, stderr: run.stderr };
}
