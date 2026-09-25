// npm's `version` lifecycle script: `npm version` has already written package.json and its lock,
// and the plugin's two manifests follow it (D184). Obsidian's sample plugin keeps its
// manifest.json in step the same way.
import { readFileSync, writeFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const { version } = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
write(".claude-plugin/plugin.json", { ...plugin, version });
const market = read(".claude-plugin/marketplace.json");
write(".claude-plugin/marketplace.json", { ...market, plugins: market.plugins.map((entry) => (entry.name === plugin.name ? { ...entry, version } : entry)) });
