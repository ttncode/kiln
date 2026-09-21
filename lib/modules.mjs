import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, integrationBranch } from "./config.mjs";

/**
 * `.gitmodules` is git's own record of what else is checked out here, so it is the source
 * and `repo.modules` is the override. No quality tool asks you to retype a module list it
 * can read: pnpm reads its workspace file, Cargo its `[workspace]`, Nx the filesystem.
 * kiln asking for one by hand is how `repo.modules` came to exist with nobody reading it.
 */
export function detectModules(root) {
  const file = join(root, ".gitmodules");
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const blocks = [...text.matchAll(/\[submodule\s+"([^"]+)"\]([^[]*)/g)];
  return Object.fromEntries(
    blocks
      .map(([, name, body]) => [kebab(name), (/^\s*path\s*=\s*(.+)$/m.exec(body)?.[1] ?? "").trim()])
      .filter(([, path]) => path && existsSync(join(root, path))),
  );
}

function kebab(name) {
  return name.replace(/[_\s]+/g, "-").replace(/([a-z\d])([A-Z])/g, "$1-$2").replace(/\/+/g, "-").toLowerCase();
}

export function modulesOf(config) {
  return config.repo?.modules ?? {};
}

/** The longest matching path wins, so `submodules/common-models` beats `submodules`. */
export function moduleFor(config, relativePath) {
  const entries = Object.entries(modulesOf(config)).sort((a, b) => b[1].length - a[1].length);
  const hit = entries.find(([, path]) => relativePath === path || relativePath.startsWith(`${path}/`));
  return hit ? hit[0] : null;
}

/**
 * D81 makes `integration_branch` per module; `protected` stayed a single flat list, and a
 * flat list describing four checkouts is right for at most one of them. Rather than grow
 * the schema a second time — D37's ratchet — the effective set is derived: what the user
 * declared, plus the branch every module actually ships from. A branch kiln would open a
 * pull request against is a branch kiln must not push to.
 */
export function protectedBranchesFor(config) {
  const declared = config.vcs?.protected ?? DEFAULTS.vcs.protected;
  const shipsFrom = [integrationBranch(config), ...Object.keys(modulesOf(config)).map((name) => integrationBranch(config, name))];
  return [...new Set([...declared, ...shipsFrom.filter(Boolean)])];
}
