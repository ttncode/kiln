import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { COLLECTIONS } from "./contract.mjs";
import { storeDir } from "./store.mjs";

/**
 * The store explorer, served the way the visual companion is: a listener on 127.0.0.1 only
 * (D83 — a loopback listener, not egress), a random token in every path so no other page or
 * local process can read the store by guessing a port, and a Host check so a DNS-rebound name
 * pointing at 127.0.0.1 is refused. Read-only: GET and HEAD of a fixed set of files, nothing
 * else. The page is tps-project-dna's own explorer, served as it ships (D84), from `vendor/`.
 */

const VENDOR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "vendor", "dna-explorer");
const TOKEN_BYTES = 16;
// Long enough to read a page already loaded, which makes no requests; short enough that a
// server left behind by an ended session does not stay up for days.
const IDLE_MS = 2 * 60 * 60 * 1000;
const PAGE = { file: join(VENDOR, "explorer.html"), type: "text/html; charset=utf-8" };
const STORE_FILES = new Set([...Object.keys(COLLECTIONS).map((name) => `${name}.jsonl`), "manifest.json"]);

/**
 * The page's own Export button fetches its source by the last segment of its address, and falls
 * back to `explorer-v2.html` when that segment is empty — which it is at `/<token>/`.
 */
function vendored(name) {
  if (["", "explorer.html", "explorer-v2.html"].includes(name)) return PAGE;
  if (name === "laneflow.js") return { file: join(VENDOR, "laneflow.js"), type: "text/javascript; charset=utf-8" };
  return null;
}

/** The page fetches `_dna_store/<file>` relative to itself; those names map onto kiln's store. */
function routeOf(root, rest) {
  const store = /^_dna_store\/([^/]+)$/.exec(rest)?.[1];
  if (store) return STORE_FILES.has(store) ? { file: join(storeDir(root), store), type: store.endsWith(".json") ? "application/json" : "application/x-ndjson" } : null;
  return vendored(rest);
}

function send(response, { status, type = "text/plain; charset=utf-8", body }) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

function allowedHost(request, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host);
}

function pathOf(url) {
  try {
    return decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
  } catch {
    // A malformed escape is a bad request, not a reason for the listener to fall over.
    return null;
  }
}

function answer(root, { request, token, port }) {
  if (!["GET", "HEAD"].includes(request.method)) return { status: 405, body: "read-only" };
  if (!allowedHost(request, port)) return { status: 403, body: "wrong host" };
  const path = pathOf(request.url);
  if (path === null) return { status: 400, body: "bad path" };
  if (!path.startsWith(`/${token}/`)) return { status: 404, body: "not found" };
  const route = routeOf(root, path.slice(token.length + 2));
  if (!route) return { status: 404, body: "not found" };
  const body = readRoute(route.file);
  if (body === null) return { status: 503, body: "the store is being rewritten; reload in a moment" };
  return { status: 200, type: route.type, body: request.method === "HEAD" ? undefined : body };
}

/**
 * `kiln dna apply` swaps the store in with two renames while this may be serving it, so a file
 * can vanish between any two lines here. That is a moment to retry, not a reason to fall over.
 */
function readRoute(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Returns the function each request calls to put the idle deadline back. */
function closeWhenIdle(server, idleMs) {
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      server.close();
      server.closeAllConnections();
    }, idleMs);
  };
  server.on("close", () => clearTimeout(timer));
  return touch;
}

/**
 * Starts listening and resolves with the URL to open. The server closes itself after
 * `idleMs` without a request, so one left running when a session ends does not stay up.
 */
export function serveExplorer(root, { port = 0, idleMs = IDLE_MS } = {}) {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const server = createServer((request, response) => {
    touch();
    try {
      send(response, answer(root, { request, token, port: server.address().port }));
    } catch (error) {
      send(response, { status: 500, body: `kiln could not read the store: ${error.message}` });
    }
  });
  const touch = closeWhenIdle(server, idleMs);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      touch();
      resolve({ url: `http://127.0.0.1:${server.address().port}/${token}/`, server });
    });
  });
}
