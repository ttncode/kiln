import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const SCHEMA_VERSION = 1;

export const DEFAULTS = {
  schema_version: SCHEMA_VERSION,
  artifact_language: "en",
  repo: { kind: "single", root: null },
  vcs: {
    provider: "github",
    protected: ["main"],
    integration_branch: "main",
    branch_pattern: "${type}/${id}",
  },
  tracker: { provider: "github" },
  stack: { id: "node", cmd: {} },
  knowledge: { tier: 0 },
  auto: { bounded: false },
  work: { committed: true },
  rules: { budget_lines: 200 },
};

export class ConfigError extends Error {}

/**
 * JSON.parse throws on a byte-order mark, which would otherwise surface as
 * "config broken" and send the user hunting for a syntax error that is not there.
 */
export function parseJsonText(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/**
 * The coder works inside one checkout of a multi-module workspace, so a cwd-only
 * lookup writes artifacts into the wrong directory. Walk up instead.
 *
 * The walk stops when `dirname` stops moving, never on a precomputed root: for a
 * relative or malformed path `parse().root` is "" while `dirname` converges on ".",
 * so the two never meet and the loop never ends. A guard runs this against a `cwd`
 * taken from hook input, and a hook that never returns is allowed to proceed
 * (measured, §1.6 row 4) — so the spin would turn every guard off silently.
 */
export function findRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (configPresent(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Present, not readable: a config nobody can read is still the project's config, and a
 * walk that skipped it on a read error went on upward, found nothing, and reported a
 * project kiln drives as one it does not — every guard off, on exactly the file that
 * turns them on (D33: unreadable is not absent).
 */
function configPresent(dir) {
  try {
    statSync(join(dir, ".kiln", "config.json"));
    return true;
  } catch (error) {
    return error.code !== "ENOENT" && error.code !== "ENOTDIR";
  }
}

/**
 * The real path, because every target a guard compares against it is a real path. A
 * project reached through a symlinked directory — macOS's `/tmp`, a workspace link — had
 * its root compared as the link while targets resolved through it, so every source edit was
 * "outside the project root" and `.kiln/config.json` was not recognised as kiln's own file.
 */
export function resolveRoot(cwd) {
  const found = process.env.KILN_ROOT || findRoot(cwd);
  if (!found) return null;
  try {
    return realpathSync(found);
  } catch {
    return found;
  }
}

export function checkSchema(fileVersion) {
  const found = fileVersion ?? SCHEMA_VERSION;
  if (found > SCHEMA_VERSION) {
    throw new ConfigError(
      `config schema_version ${found} is newer than this kiln understands (${SCHEMA_VERSION}). Update kiln, or check out a matching version.`,
    );
  }
  return { migrated: found < SCHEMA_VERSION, foundVersion: found };
}

export function configPath(root) {
  return join(root, ".kiln", "config.json");
}

/**
 * Returns `migrated: true` when the file was written by an older kiln. The
 * migration is in memory only — a tracked file is never silently rewritten.
 */
export function loadConfig(cwd) {
  const root = resolveRoot(cwd);
  if (!root) throw new ConfigError("no .kiln/config.json found here or in any parent directory. Run `kiln init`.");
  const raw = parseJsonText(readFileSync(configPath(root), "utf8"));
  const { migrated, foundVersion } = checkSchema(raw.schema_version);
  const config = deepMerge(DEFAULTS, raw);
  config.schema_version = SCHEMA_VERSION;
  return { root, config, migrated, foundVersion };
}

/**
 * A multi-module workspace can hold checkouts on differently named integration
 * branches, so this accepts the map D81 allows as well as the scalar.
 */
export function integrationBranch(config, module) {
  const declared = config.vcs.integration_branch;
  if (typeof declared === "string") return declared;
  return declared?.[module] ?? DEFAULTS.vcs.integration_branch;
}
