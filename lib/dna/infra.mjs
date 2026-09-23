import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { loadStack } from "../stack.mjs";
import { serviceOfPath } from "./derive.mjs";
import { repositories } from "./scan.mjs";

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

const FRONTEND = /front|(?:^|[-_])fe$|web|client|\bui\b|app-?ui/i;
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

/**
 * A module is a service. A single repository is one deployable until someone says otherwise, so
 * its code directories become one service's roots — split in two only where a directory is
 * named like a front end, the one split a path can honestly suggest.
 */
function codeServices(repos, { files, used, project }) {
  const modules = repos.filter((repo) => repo.path);
  if (modules.length > 0) return modules.map((repo) => service({ name: repo.name, roots: [repo.path], used }));
  const tops = topDirectories(files);
  const front = tops.filter((top) => FRONTEND.test(top));
  const back = tops.filter((top) => !FRONTEND.test(top));
  return [
    ...(back.length > 0 ? [service({ name: project, roots: back, used, kind: "BACKEND" })] : []),
    ...(front.length > 0 ? [service({ name: `${project}-web`, roots: front, used, kind: "FRONTEND" })] : []),
  ];
}

function service({ name, roots, used, kind = FRONTEND.test(name) ? "FRONTEND" : "BACKEND" }) {
  return { id: unique("SVC", { base: mnemonic(name), used }), name, kind, root_paths: roots };
}

function topDirectories(files) {
  const code = files.filter((file) => file.class === "CANDIDATE" || file.class === "SHELL");
  return [...new Set(code.filter((file) => file.path.includes("/")).map((file) => file.path.split("/")[0]))].sort();
}

/** `image:` lines only: kiln carries no YAML parser, and the image name is the whole signal. */
function composeServices(repos, { files, used }) {
  const images = files.filter((file) => COMPOSE.test(file.path)).flatMap((file) => {
    const repo = repos.find((each) => each.name === file.repo);
    return [...read(repo, file.blob).matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)].map((match) => ({ image: match[1], path: file.path }));
  });
  return images.map(({ image }) => {
    const kind = IMAGE_KIND.find(([pattern]) => pattern.test(image))?.[1];
    return kind ? { id: unique("SVC", { base: mnemonic(image.split("/").pop().split(":")[0]), used }), name: image, kind } : null;
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

function matchingRule(rules, { file, text }) {
  return rules.find((rule) => new RegExp(rule.files).test(file.path) && (!rule.contains || new RegExp(rule.contains, "m").test(text())));
}

/** One surface per file a rule matches: the file is the evidence, and a person names it. */
function ruleSurfaces(repos, { files, rules, used }) {
  if (rules.length === 0) return [];
  const eligible = files.filter((file) => file.class === "CANDIDATE" || file.class === "SHELL");
  return eligible.flatMap((file) => {
    const repo = repos.find((each) => each.name === file.repo);
    const rule = matchingRule(rules, { file, text: () => read(repo, file.blob) });
    if (!rule) return [];
    const stem = file.path.split("/").pop().replace(/\.[^.]+$/, "");
    return [{ id: unique("SRF", { base: `${mnemonic(stem)}-${rule.kind.slice(0, 3)}`, used }), name: stem, kind: rule.kind, primary_paths: [file.path] }];
  });
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
  return { settings: { evidence_sources: sources }, upsert: { services, surfaces } };
}
