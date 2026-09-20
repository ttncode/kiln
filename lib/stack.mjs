import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonText } from "./config.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export class StackError extends Error {}

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

export function effectIds(stack) {
  return (stack.effects ?? []).map((effect) => effect.id);
}
