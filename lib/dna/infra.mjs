import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { loadStack } from "../stack.mjs";
import { serviceOfPath } from "./derive.mjs";
import { contents, repositories } from "./scan.mjs";
import { readStore } from "./store.mjs";

/**
 * The bootstrap's Phase 2b infra map, drafted without an LLM — `bootstrap_infra_map.py`'s job.
 * The output is a batch for a person to review, never applied by this command: which services
 * exist and what they are called is a naming decision that outlives the run, and the source
 * refuses to write its draft over the live map for the same reason.
 *
 * Two departures, both toward fewer guesses. Services come from the repositories kiln already
 * knows and from the images a compose file names, rather than from finding-path clusters alone.
 * Surfaces come from rules a stack file declares (D61) — a route, a view, a schedule — instead
 * of the source's directory-name heuristic, which its own field audit found minting SCREEN
 * records for widget libraries.
 */

const FRONTEND = /^(?:web|www|webapp|frontend|front|client|clients|ui|fe|mobile|ios|android|app-ui)$|[-_](?:web|frontend|ui|client|fe|mobile)$/i;
const NOT_A_BACKING_SERVICE = /exporter|admin|commander|insight|dashboard|-ui$/i;
const COMPOSE = /(?:^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/;
const IMAGE_KIND = [
  [/postgres|mysql|mariadb|mongo|mssql|oracle|cockroach|sqlite/i, "DATABASE"],
  [/redis|memcache|valkey/i, "CACHE"],
  [/rabbitmq|kafka|nats|activemq|sqs|pubsub/i, "QUEUE"],
  [/elasticsearch|opensearch|solr|meilisearch|typesense/i, "SEARCH"],
  [/nginx|traefik|haproxy|envoy|kong/i, "GATEWAY"],
];
const MNEMONIC_LENGTH = 16;

function mnemonic(text) {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MNEMONIC_LENGTH) || "MAIN";
}

function unique(prefix, { base, used }) {
  let id = `${prefix}-${base}`;
  for (let n = 2; used.has(id); n += 1) id = `${prefix}-${base}-${n}`;
  used.add(id);
  return id;
}

function read(repo, blob) {
  return execFileSync("git", ["cat-file", "blob", blob], { cwd: repo.dir, encoding: "utf8", maxBuffer: 1 << 28 });
}

function isCode(file) {
  return file.class === "CANDIDATE" || file.class === "SHELL";
}

/**
 * The project's own code is one deployable until someone says otherwise, so its directories
 * become one service's roots — split only where a directory is named like a front end, the one
 * split a path can honestly suggest. A module (D81) is a service of its own.
 */
function codeServices(repos, { files, used, project }) {
  const modules = repos.filter((repo) => repo.path).map((repo) => service({ name: repo.name, roots: [repo.path], used }));
  const roots = rootEntries(files.filter((file) => file.repo === "root"));
  const front = roots.filter((root) => FRONTEND.test(root));
  const back = roots.filter((root) => !FRONTEND.test(root));
  return [
    ...(back.length > 0 ? [service({ name: project, roots: back, used, kind: "BACKEND" })] : []),
    ...(front.length > 0 ? [service({ name: `${project}-web`, roots: front, used, kind: "FRONTEND" })] : []),
    ...modules,
  ];
}

function service({ name, roots, used, kind = FRONTEND.test(name) ? "FRONTEND" : "BACKEND" }) {
  return { id: unique("SVC", { base: mnemonic(name), used }), name, kind, root_paths: roots };
}

/** Top-level directories holding code, and code files at the top itself; dot-directories are tooling. */
function rootEntries(files) {
  const entries = files.filter(isCode).map((file) => file.path.split("/")[0]).filter((entry) => !entry.startsWith("."));
  return [...new Set(entries)].sort();
}

/**
 * `image:` lines only: kiln carries no YAML parser, and the image name is the whole signal. The
 * same image in several compose files is one service, and a tool that watches a database is not
 * a database.
 */
function composeServices(repos, { files, used }) {
  const images = files.filter((file) => COMPOSE.test(file.path)).flatMap((file) => {
    const repo = repos.find((each) => each.name === file.repo);
    return [...read(repo, file.blob).matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)].map((match) => match[1].split("/").pop().split(":")[0].split("@")[0]);
  });
  return [...new Set(images)].filter((name) => !NOT_A_BACKING_SERVICE.test(name)).map((name) => {
    const kind = IMAGE_KIND.find(([pattern]) => pattern.test(name))?.[1];
    return kind ? { id: unique("SVC", { base: mnemonic(name), used }), name, kind } : null;
  }).filter(Boolean);
}

function surfaceRules(stackId) {
  try {
    return loadStack(stackId).dna?.surfaces ?? [];
  } catch {
    // An undetected or unknown stack declares no surface rules; the draft then has services only.
    return [];
  }
}

/**
 * A rule matches by path, and by content when it names a pattern. Only files some rule's path
 * pattern selects are read, and all of them in one `cat-file --batch` per repository.
 */
function ruleSurfaces(repos, { files, rules, used }) {
  if (rules.length === 0) return [];
  const byPath = rules.map((rule) => ({ ...rule, path: new RegExp(rule.files), text: rule.contains ? new RegExp(rule.contains, "m") : null }));
  const eligible = files.filter((file) => isCode(file) && byPath.some((rule) => rule.path.test(file.path)));
  const texts = new Map(repos.flatMap((repo) => [...contents(repo.dir, eligible.filter((file) => file.repo === repo.name).map((file) => file.blob))]));
  return eligible.flatMap((file) => {
    const text = texts.get(file.blob)?.toString("utf8") ?? "";
    const rule = byPath.find((each) => each.path.test(file.path) && (!each.text || each.text.test(text)));
    if (!rule) return [];
    const stem = file.path.split("/").pop().replace(/\.[^.]+$/, "");
    return [{ id: unique("SRF", { base: `${mnemonic(stem)}-${rule.kind.slice(0, 3)}`, used }), name: stem, kind: rule.kind, primary_paths: [file.path] }];
  });
}

/**
 * D176: the component tier's one authored input, drafted for the same review as the services.
 * The source leaves `components.custom` to be typed by hand and reads its absence as all
 * VENDOR — right for the Odoo fork it was measured on, backwards for a project that wrote its
 * own code, where no step ever asked. Its own glossary defines a PROJECT component as one "the
 * project owns", so those are drafted CUSTOM; ADDON and FRAMEWORK roots, the platform's shapes,
 * are left for the person to add. A list already declared is theirs and is not redrafted.
 */
function draftComponents(root) {
  const { data, settings } = readStore(root);
  if (settings.components) return {};
  const owned = data.components.filter((component) => component.kind === "PROJECT").map((component) => component.name);
  return owned.length > 0 ? { components: { custom: owned } } : {};
}

/** Once a list is declared, a PROJECT root a later round found is named for the person rather than added. */
export function undeclaredComponents(root) {
  const { data, settings } = readStore(root);
  if (!settings.components) return [];
  const custom = new Set(settings.components.custom ?? []);
  return data.components.filter((component) => component.kind === "PROJECT" && !custom.has(component.name)).map((component) => component.name);
}

/** The draft batch: evidence sources, services and surfaces, for review before `kiln dna apply`. */
export function draftInfra(root, { config, scan }) {
  const repos = repositories(root, config);
  const files = scan.files;
  const used = new Set();
  const project = config.project ?? basename(root);
  const services = [...codeServices(repos, { files, used, project }), ...composeServices(repos, { files, used })];
  const surfaces = ruleSurfaces(repos, { files, rules: surfaceRules(config.stack?.id), used }).map((surface) => {
    const owner = serviceOfPath(surface.primary_paths[0], { services });
    return owner ? { ...surface, service_id: owner } : surface;
  });
  const sources = repos.map((repo) => ({ id: repo.name, kind: "SOURCE_CODE", root: repo.path || "." }));
  return { settings: { evidence_sources: sources, ...draftComponents(root) }, upsert: { services, surfaces } };
}
