import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonText } from "./config.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export class StackError extends Error {}

/**
 * What `init` writes when detection recognised nothing — D92's "ask the user" rather than a
 * guess. It is a sentinel, never a file to look for: `stacks/unknown.json` does not exist
 * and is not meant to.
 */
export const UNDETECTED = "unknown";

export function stacksDir() {
  return join(PLUGIN_ROOT, "stacks");
}

export function loadStack(id) {
  try {
    return parseJsonText(readFileSync(join(stacksDir(), `${id}.json`), "utf8"));
  } catch {
    throw new StackError(`no stack named "${id}". Adding one means writing stacks/${id}.json.`);
  }
}

/** A stack contributes guards by naming scripts; kiln never discovers them (D8). */
export function guardsFor(stack, phase) {
  return (stack.guards ?? [])
    .filter((guard) => guard.phase === phase)
    .map((guard) => ({ ...guard, path: join(stacksDir(), guard.script) }));
}

/**
 * A stack's steps are a default, not a decree. init writes the set it detected — D40's
 * finding was that three real Node projects gave three different answers, so shipping
 * one of them as unconditional makes kiln wrong on most projects.
 */
export function effectiveSteps(stack, config) {
  return config?.stack?.steps ?? stack.steps ?? [];
}

export function effectIds(stack) {
  return (stack.effects ?? []).map((effect) => effect.id);
}
