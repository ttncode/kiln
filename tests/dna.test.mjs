import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { canonical } from "../lib/dna/contract.mjs";
import { componentId, componentRoot, derive, serviceOfPath, stripDerived } from "../lib/dna/derive.mjs";
import { jargonHits, runGates } from "../lib/dna/gates.mjs";
import { idScheme, nextId } from "../lib/dna/ids.mjs";
import { applyBatch, checkStore } from "../lib/dna/apply.mjs";
import { readStore, storeDir } from "../lib/dna/store.mjs";
import { classByPath, measure, scanProject } from "../lib/dna/scan.mjs";
import { cleanupFixtures, commitAll, initRepo, tempRoot, writeConfig, writeFile } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const TODAY = "2026-09-23";

function project() {
  const root = initRepo(tempRoot("kiln-dna-"));
  writeFile(join(root, "package.json"), '{"name":"d"}');
  commitAll(root, "init");
  writeConfig(root, DEFAULTS);
  return root;
}

function kiln(root, args) {
  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
}

function empty() {
  return { domains: [], capabilities: [], features: [], excluded: [], findings: [], flows: [], stages: [], processes: [], updates: [], intakes: [], releases: [], debts: [], services: [], surfaces: [], components: [], edges: [] };
}

const DESCRIPTION = { what_it_does: "Turns a title into a web address", input: "A title", process: "Lowercases it and joins the words", output: "A short address" };

/** A small but whole store: one of each tier, findings owned by a feature, one service. */
function seedBatch() {
  return {
    settings: { project: "slugger" },
    upsert: {
      domains: [{ id: "DOM-TXT", name: "Text", key: "dom" }],
      capabilities: [{ key: "cap", domain_id: "@dom", name: "Addresses" }],
      features: [{ key: "feat", capability_id: "@cap", domain_id: "@dom", name: "Slugify", business_description: DESCRIPTION, rd_ids: ["@f1", "@f2"] }],
      findings: [
        { key: "f1", category: "behavior", proposition: "slugify lowercases its input", module: "src/slug.js", evidence: [{ src: "code", ref: "src/slug.js", loc: "L3" }] },
        { key: "f2", category: "behavior", proposition: "slugify joins words with a dash", module: "src/slug.js" },
      ],
      services: [{ id: "SVC-APP", name: "App", kind: "BACKEND", root_paths: ["src"] }],
    },
  };
}

// ------------------------------------------------------------------ the contract

test("DNA canonical: core fields in contract order, the rest under ext, provenance on the line", () => {
  const record = canonical("feature", { name: "Slugify", owner_team: "web", id: "DOM-TXT-01-01", legacy_feature_id: "F-9", capability_id: "DOM-TXT-01", rd_ids: [] });
  assert.deepEqual(Object.keys(record), ["entity", "id", "capability_id", "name", "legacy_feature_id", "ext"]);
  assert.deepEqual(record.ext, { owner_team: "web" });
  assert.deepEqual(canonical("feature", record), record, "a record read back from the store canonicalises to itself");
});

test("DNA ids: counted from the highest ever seen, padded, and nested under the parent", () => {
  assert.equal(nextId(["RD-0001", "RD-0007"], idScheme("finding", {})), "RD-0008", "a gap stays a gap");
  assert.equal(nextId(["RD-0001"], idScheme("finding", { status: "PLANNED" })), "PRD-0001", "a planned finding has its own namespace");
  assert.equal(nextId(["DOM-TXT-01", "DOM-TXT-03", "DOM-OPS-09"], idScheme("capability", { domain_id: "DOM-TXT" })), "DOM-TXT-04");
  assert.equal(nextId([], idScheme("process", { stage_id: "BF-02.S1" })), "BF-02.S1.P1");
  assert.equal(nextId(["UPD-2026-09-23-01"], idScheme("update", { date: TODAY })), "UPD-2026-09-23-02");
  assert.equal(idScheme("domain", {}), null, "a domain's abbreviation is chosen by a person");
  assert.equal(idScheme("service", {}), null);
});

// ------------------------------------------------------------------ derivations

test("DNA service_id: the longest root owns a path, by whole segments", () => {
  const services = [{ id: "SVC-WEB", root_paths: ["addons/web"] }, { id: "SVC-BE", root_paths: ["addons"] }];
  assert.equal(serviceOfPath("addons/web/static/app.js", { services }), "SVC-WEB");
  assert.equal(serviceOfPath("addons/website_sale/models.py", { services }), "SVC-BE", "addons/web does not own addons/website_sale");
  assert.equal(serviceOfPath("lib/x.js", { services }), null);
});

test("DNA derive: a keyword claims a module only when one service's does, and a shared surface prefix sets nothing", () => {
  const data = {
    ...empty(),
    services: [{ id: "SVC-A", kind: "BACKEND", module_keywords: ["billing"] }, { id: "SVC-B", kind: "BACKEND", module_keywords: ["bill"] }, { id: "SVC-C", kind: "BACKEND", module_keywords: ["report"] }],
    surfaces: [{ id: "SRF-ONE", kind: "API", primary_paths: ["api/shared"] }, { id: "SRF-TWO", kind: "API", primary_paths: ["api/shared"] }],
    findings: [{ id: "RD-0001", module: "billing/invoice.js" }, { id: "RD-0002", module: "report/x.js" }, { id: "RD-0003", module: "api/shared/a.js" }],
  };
  const [billing, report, shared] = derive(data, {}).findings;
  assert.equal(billing.service_id, undefined, "two services' keywords match billing");
  assert.equal(report.service_id, "SVC-C");
  assert.equal(shared.surface_id, undefined);
});

test("DNA components: the literal module root, one record per root, with the owning service", () => {
  assert.deepEqual(componentRoot("server/addons/sale_x/models/a.py"), { root: "sale_x", kind: "ADDON", prefix: "server/addons/sale_x" });
  assert.deepEqual(componentRoot("server/odoo/models/b.py"), { root: "odoo/models", kind: "FRAMEWORK", prefix: "server/odoo/models" });
  assert.equal(componentId("src/slug"), "CMP-SRC-SLUG");
  const data = { ...empty(), services: [{ id: "SVC-APP", kind: "BACKEND", root_paths: ["src"] }], findings: [{ id: "RD-0001", module: "src/slug/a.js" }, { id: "RD-0002", module: "src/slug/b.js" }] };
  const derived = derive(data, { components: { custom: ["src/slug"] } });
  assert.equal(derived.components.length, 1);
  assert.equal(derived.components[0].origin, "CUSTOM");
  assert.equal(derived.components[0].service_id, "SVC-APP");
  assert.equal(derived.components[0].finding_count, 2);
  assert.ok(derived.findings.every((finding) => finding.component_id === "CMP-SRC-SLUG"));
});

test("DNA hop-lift: a call site lifts to a CALLS edge, and an authored edge gains hop_support instead", () => {
  const data = {
    ...empty(),
    services: [{ id: "SVC-APP", kind: "BACKEND", root_paths: ["src"] }, { id: "SVC-MAIL", kind: "EXTERNAL" }, { id: "SVC-PAY", kind: "EXTERNAL" }],
    edges: [
      { entity: "edge", from: "BF-01.S1.P1", to: "SVC-MAIL", kind: "EXTERNAL_HOP", channel: "mail", derivation: "function-match", evidence: "src/notify.js:12" },
      { entity: "edge", from: "BF-01.S1.P1", to: "SVC-PAY", kind: "EXTERNAL_HOP", channel: "http", derivation: "function-match", evidence: "src/pay.js:3" },
      { entity: "edge", from: "SVC-APP", to: "SVC-PAY", kind: "TOPOLOGY", type: "CALLS" },
    ],
  };
  const edges = derive(data, {}).edges;
  const lifted = edges.find((edge) => edge.derivation === "hop-lift");
  assert.deepEqual([lifted.from, lifted.to, lifted.support, lifted.channels], ["SVC-APP", "SVC-MAIL", 1, ["mail"]]);
  assert.equal(edges.find((edge) => edge.kind === "TOPOLOGY" && edge.to === "SVC-PAY").hop_support, 1);
  assert.deepEqual(stripDerived({ ...data, edges }).edges, data.edges, "stripping takes back exactly what deriving added");
});

// ------------------------------------------------------------------ gates

test("DNA jargon-lint: technical words and code identifiers in business text, not abbreviations", () => {
  assert.deepEqual(jargonHits("Calls the API endpoint on res.partner"), ["API", "endpoint", "res.partner"]);
  assert.deepEqual(jargonHits("Customers pay, e.g. by card"), []);
});

test("DNA gates: a planned finding outside the PRD namespace, a debt settled by nothing, a bare-string rule bucket", () => {
  const data = {
    ...empty(),
    findings: [{ id: "RD-0001", status: "PLANNED" }],
    debts: [{ id: "DEBT-2026-09-23-01", kind: "HOTFIX", status: "SETTLED", settled_by: "UPD-2026-09-23-09" }],
    processes: [{ id: "BF-01.S1.P1", business_rules: "one rule" }],
  };
  const failed = runGates({ data, settings: {} }).failed.map((result) => result.label);
  assert.ok(failed.includes("PLANNED findings use the PRD-#### namespace, never RD-####"));
  assert.ok(failed.includes("debts: kind/status closed vocab; SETTLED cites a real update round"));
  assert.ok(failed.includes("processes: every rule-bucket field is a list"));
});

// ------------------------------------------------------------------ the write path

test("DNA apply: one batch assigns every counted id, resolves keys, derives, and writes a gated store", () => {
  const root = project();
  const plan = applyBatch(root, { batch: seedBatch(), today: TODAY });
  assert.deepEqual(plan.assigned.map(({ key, id }) => [key, id]), [["dom", "DOM-TXT"], ["cap", "DOM-TXT-01"], ["feat", "DOM-TXT-01-01"], ["f1", "RD-0001"], ["f2", "RD-0002"], [undefined, "SVC-APP"]]);
  const { data, manifest, settings } = readStore(root);
  assert.deepEqual(data.features[0].rd_ids, ["RD-0001", "RD-0002"]);
  assert.ok(data.findings.every((finding) => finding.feature_id === "DOM-TXT-01-01" && finding.service_id === "SVC-APP" && finding.component_id === "CMP-SRC-SLUG-JS"));
  assert.equal(manifest.counts.findings, 2);
  assert.equal(manifest.adapter, "kiln");
  assert.equal(settings.project, "slugger");
  assert.equal(checkStore(root).failed.length, 0);
});

test("DNA apply: a failing gate writes nothing", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  const before = readFileSync(join(storeDir(root), "features.jsonl"), "utf8");
  const jargon = { upsert: { features: [{ id: "DOM-TXT-01-01", business_description: { ...DESCRIPTION, process: "Calls the API endpoint" } }] } };
  assert.throws(() => applyBatch(root, { batch: jargon, today: TODAY }), /jargon-lint on feature business_description/);
  const homeless = { upsert: { features: [{ capability_id: "DOM-TXT-01", name: "Orphan" }, { id: "DOM-TXT-09-01", name: "No parent" }] } };
  assert.throws(() => applyBatch(root, { batch: homeless, today: TODAY }), /every feature names its capability|denormalized ancestor/);
  assert.equal(readFileSync(join(storeDir(root), "features.jsonl"), "utf8"), before);
});

test("DNA apply: a store built one batch at a time is the store one batch builds", () => {
  const whole = project();
  applyBatch(whole, { batch: seedBatch(), today: TODAY });
  const stepwise = project();
  const { settings, upsert } = seedBatch();
  applyBatch(stepwise, { batch: { settings, upsert: { services: upsert.services, domains: upsert.domains } }, today: TODAY });
  applyBatch(stepwise, { batch: { upsert: { capabilities: [{ ...upsert.capabilities[0], domain_id: "DOM-TXT" }], findings: upsert.findings } }, today: TODAY });
  applyBatch(stepwise, { batch: { upsert: { features: [{ ...upsert.features[0], capability_id: "DOM-TXT-01", domain_id: "DOM-TXT", rd_ids: ["RD-0001", "RD-0002"] }] } }, today: TODAY });
  const order = (data) => Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  assert.deepEqual(order(readStore(stepwise).data), order(readStore(whole).data));
});

test("DNA apply: findings are never removed, and a merged node's id is never counted again", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  assert.throws(() => applyBatch(root, { batch: { remove: { findings: ["RD-0001"] } }, today: TODAY }), /cannot remove findings/);
  applyBatch(root, { batch: { upsert: { capabilities: [{ domain_id: "DOM-TXT", name: "Two" }] } }, today: TODAY });
  applyBatch(root, { batch: { remove: { capabilities: ["DOM-TXT-02"] }, upsert: { capabilities: [{ id: "DOM-TXT-01", merged_from: ["DOM-TXT-02"] }] } }, today: TODAY });
  const plan = applyBatch(root, { batch: { upsert: { capabilities: [{ domain_id: "DOM-TXT", name: "Three" }] } }, today: TODAY });
  assert.equal(plan.assigned[0].id, "DOM-TXT-03");
});

test("DNA check: a derived field edited by hand is found, and so is a count the manifest does not hold", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  const path = join(storeDir(root), "findings.jsonl");
  writeFileSync(path, readFileSync(path, "utf8").replace(/"service_id":"SVC-APP",/, ""));
  assert.deepEqual(checkStore(root).failed.map((result) => result.label), ["derived fields are what the records derive to"]);
  writeFileSync(path, readFileSync(path, "utf8").split("\n").slice(1).join("\n"));
  assert.ok(checkStore(root).failed.some((result) => result.label === "conservation: manifest counts match recount"));
});

// ------------------------------------------------------------------ the command

test("kiln dna: status before and after a store exists, apply prints the ids it assigned, check exits by the gates", () => {
  const root = project();
  assert.match(kiln(root, ["dna"]).stdout, /No DNA store in this project yet/);
  const batch = join(root, ".kiln", "tmp", "batch.json");
  writeFile(batch, JSON.stringify(seedBatch()));
  const applied = kiln(root, ["dna", "apply", batch]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /RD-0001 ← f1/);
  const status = kiln(root, ["dna", "status"]);
  assert.match(status.stdout, /DNA store · slugger · methodology 2\.18\.1/);
  assert.match(status.stdout, /findings 2/);
  assert.match(status.stdout, /not pinned to any commit yet/);
  assert.equal(kiln(root, ["dna", "check"]).status, 0);
  writeFile(batch, JSON.stringify({ upsert: { components: [{ id: "CMP-X" }] } }));
  const refused = kiln(root, ["dna", "apply", batch]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /components are derived from findings/);
  assert.match(kiln(root, ["dna", "frobnicate"]).stderr, /kiln dna has no verb "frobnicate"/);
});

// ------------------------------------------------------------------ D153 review round

test("DNA apply: changing a dated record keeps its date, so the id and the date agree", () => {
  const root = project();
  applyBatch(root, { batch: { upsert: { updates: [{ kind: "SCAN", title: "first", date: "2026-01-05" }] } }, today: TODAY });
  applyBatch(root, { batch: { upsert: { updates: [{ id: "UPD-2026-01-05-01", title: "renamed" }] } }, today: TODAY });
  assert.equal(readStore(root).data.updates[0].date, "2026-01-05");
});

test("DNA apply: a batch cannot author a derived field, so what it writes is what a rebuild derives", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  const cases = [
    { upsert: { findings: [{ id: "RD-0001", service_id: "SVC-APP" }] } },
    { upsert: { findings: [{ id: "RD-0001", component_id: "CMP-X" }] } },
    { upsert: { findings: [{ id: "RD-0001", feature_id: "DOM-TXT-01-01" }] } },
    { upsert: { edges: [{ from: "SVC-APP", to: "SVC-APP", kind: "TOPOLOGY", type: "CALLS", derivation: "hop-lift", support: 1 }] } },
  ];
  for (const batch of cases) assert.throws(() => applyBatch(root, { batch, today: TODAY }), /derived/, JSON.stringify(batch));
  assert.equal(checkStore(root).failed.length, 0);
});

test("DNA apply: an id in id_history is history, and a new record may not take a historical id", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  applyBatch(root, { batch: { upsert: { features: [{ id: "DOM-TXT-01-01", id_history: ["DOM-TXT-01-02"] }] } }, today: TODAY });
  const plan = applyBatch(root, { batch: { upsert: { features: [{ capability_id: "DOM-TXT-01", domain_id: "DOM-TXT", name: "Next" }] } }, today: TODAY });
  assert.equal(plan.assigned[0].id, "DOM-TXT-01-03");
  assert.throws(() => applyBatch(root, { batch: { upsert: { features: [{ id: "DOM-TXT-01-02", capability_id: "DOM-TXT-01", name: "Reuse" }] } }, today: TODAY }), /history/);
});

test("DNA gates: an empty provenance field fails, as the source's check_gates does", () => {
  const data = { ...empty(), features: [{ id: "DOM-TXT-01-01", capability_id: "DOM-TXT-01", previous_feature_id: "" }], capabilities: [{ id: "DOM-TXT-01" }] };
  assert.ok(runGates({ data, settings: {} }).failed.some((result) => result.label === "provenance fields non-empty where present"));
});

test("DNA apply: removing a parent that still has children is refused by the gates", () => {
  const root = project();
  applyBatch(root, { batch: { upsert: { domains: [{ id: "DOM-TXT", key: "d" }], capabilities: [{ domain_id: "@d", name: "C" }], flows: [{ key: "f", name: "F" }], stages: [{ flow_id: "@f", name: "S" }] } }, today: TODAY });
  assert.throws(() => applyBatch(root, { batch: { remove: { flows: ["BF-01"] } }, today: TODAY }), /ancestor/);
  assert.throws(() => applyBatch(root, { batch: { remove: { domains: ["DOM-TXT"] } }, today: TODAY }), /ancestor/);
});

test("DNA store: a write interrupted between its two renames is recovered, not read as an empty store", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  renameSync(storeDir(root), `${storeDir(root)}.previous`);
  assert.equal(readStore(root).data.findings.length, 2);
  assert.ok(existsSync(storeDir(root)));
});

test("DNA apply: only a whole `@key` word is a reference, and null removes a field wherever it is kept", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  applyBatch(root, { batch: { upsert: { features: [{ id: "DOM-TXT-01-01", name: "@mention handling", owner_team: "web" }] } }, today: TODAY });
  applyBatch(root, { batch: { upsert: { features: [{ id: "DOM-TXT-01-01", owner_team: null }] } }, today: TODAY });
  const [feature] = readStore(root).data.features;
  assert.equal(feature.name, "@mention handling");
  assert.equal(feature.ext, undefined);
});

test("DNA apply: a malformed batch is refused in words, never as a crash", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  for (const batch of [{ remove: { features: [5] } }, { remove: { features: "x" } }, { upsert: { features: {} } }, { upsert: { features: ["x"] } }, { upserts: {} }]) {
    assert.throws(() => applyBatch(root, { batch, today: TODAY }), (error) => error.constructor.name === "DnaError", JSON.stringify(batch));
  }
});

test("DNA derive: when two excluded entries claim a finding, the first keeps it, as in the source", () => {
  const data = { ...empty(), excluded: [{ id: "EXC-1", rd_ids: ["RD-0001"] }, { id: "EXC-2", rd_ids: ["RD-0001"] }], findings: [{ id: "RD-0001" }] };
  assert.equal(derive(data, {}).findings[0].feature_id, "EXC-1");
});

// ------------------------------------------------------------------ the scan (bootstrap phase 1)

const BRANCHY = "export function price(order) {\n  if (order.vip) return 0;\n  if (order.total > 100 && order.coupon) return 5;\n  for (const line of order.lines) if (line.free) return 1;\n  return 10;\n}\n";

function scanned() {
  const root = project();
  writeFile(join(root, "src/price.js"), BRANCHY);
  writeFile(join(root, "src/names.js"), "export const NAMES = ['a', 'b'];\n");
  writeFile(join(root, "src/price.test.js"), BRANCHY);
  writeFile(join(root, "vendor/lib.js"), BRANCHY);
  writeFile(join(root, "README.md"), "if and while\n");
  commitAll(root, "code");
  return root;
}

test("DNA scan: classes by path and branching, and ranks only what is worth reading", () => {
  assert.equal(classByPath({ path: "src/a.test.js", size: 10 }), "TEST");
  assert.equal(classByPath({ path: "node_modules/x/a.js", size: 10 }), "OTHER");
  assert.equal(classByPath({ path: ".kiln/hooks/pre-push.mjs", size: 10 }), "OTHER");
  assert.equal(classByPath({ path: "docs/a.md", size: 10 }), "OTHER");
  assert.equal(classByPath({ path: "src/a.js", size: 10 }), null);
  assert.deepEqual(measure("if (a && b) {\n}\n\n"), { lines: 2, branches: 2, density: 1 });
  const root = scanned();
  const { files, repos } = scanProject(root, { config: { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: "main" } }, ledger: {} });
  assert.equal(repos[0].pinnable, true);
  const classOf = Object.fromEntries(files.map((file) => [file.path, file.class]));
  assert.equal(files[0].path, "src/price.js");
  assert.equal(classOf["src/price.js"], "CANDIDATE");
  assert.equal(classOf["src/names.js"], "SHELL");
  assert.equal(classOf["src/price.test.js"], "TEST");
  assert.equal(classOf["vendor/lib.js"], "OTHER");
});

test("kiln dna scan: a round's skeleton, once applied, marks its files scanned at their blob and pins the store", () => {
  const root = scanned();
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).stdout.trim();
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: branch } });
  const listed = kiln(root, ["dna", "scan", "--out", ".kiln/tmp/round-1"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /candidates 1 \(0 scanned, 1 unscanned\)/);
  const skeleton = JSON.parse(readFileSync(join(root, ".kiln/tmp/round-1/scan-001.json"), "utf8"));
  assert.deepEqual(skeleton.scan.files, ["src/price.js"]);
  assert.equal(skeleton.read[0].at, "src/price.js", "the working tree holds the same blob, so the file is read where it is");
  skeleton.upsert.findings.push({ category: "CODE_ONLY", proposition: "A VIP order ships free", module: "src/price.js", evidence: [{ src: "root", ref: "src/price.js", loc: "L2" }] });
  writeFile(join(root, ".kiln/tmp/round-1/scan-001.json"), JSON.stringify(skeleton));
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/round-1/scan-001.json"]).status, 0);
  assert.match(kiln(root, ["dna"]).stdout, new RegExp(`pinned to root ${skeleton.scan.commits.root.slice(0, 12)}`));
  assert.match(kiln(root, ["dna", "scan"]).stdout, /No unscanned candidate: the scan is exhausted/);

  writeFile(join(root, "src/price.js"), `${BRANCHY}// changed\n`);
  commitAll(root, "change");
  assert.match(kiln(root, ["dna", "scan"]).stdout, /1 unscanned/, "a changed file is unscanned again, because the ledger holds blobs");
});

test("kiln dna scan: a file that differs in the working tree is read from the commit's copy", () => {
  const root = scanned();
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).stdout.trim();
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: branch } });
  writeFile(join(root, "src/price.js"), "// work in progress\n");
  kiln(root, ["dna", "scan", "--out", ".kiln/tmp/round-1"]);
  const [entry] = JSON.parse(readFileSync(join(root, ".kiln/tmp/round-1/scan-001.json"), "utf8")).read;
  assert.match(entry.at, /^\.kiln\/tmp\/dna\/[0-9a-f]{12}\/src\/price\.js$/);
  assert.equal(readFileSync(join(root, entry.at), "utf8"), BRANCHY);
  assert.match(kiln(root, ["dna", "scan", "--out", "/tmp/elsewhere"]).stderr, /--out must be under/);
});

test("DNA apply: a scan round cannot record a file its commit does not hold, and never pins off the integration branch", () => {
  const root = scanned();
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const config = { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: "no-such-branch" } };
  assert.throws(() => applyBatch(root, { batch: { scan: { commits: { root: head }, files: ["src/missing.js"] } }, today: TODAY, config }), /has no src\/missing\.js/);
  applyBatch(root, { batch: { scan: { commits: { root: head }, files: ["src/price.js"] } }, today: TODAY, config });
  const { manifest, scanned: ledger } = readStore(root);
  assert.deepEqual(manifest.source_pins, {}, "HEAD is not the integration branch, so it is read but not pinned (D80)");
  assert.ok(ledger["src/price.js"]);
});

// ------------------------------------------------------------------ the infra draft (bootstrap phase 2b)

test("kiln dna infra: services from code directories and compose images, surfaces from the stack's rules, and a draft that applies", () => {
  const root = project();
  writeFile(join(root, "server/routes.js"), "router.get('/orders', list);\nif (a) b();\nif (c) d();\n");
  writeFile(join(root, "server/jobs.js"), "cron.schedule('0 * * * *', run);\n");
  writeFile(join(root, "server/util.js"), "export const x = 1;\n");
  writeFile(join(root, "web/pages/index.tsx"), "export default function Home() { return null; }\n");
  writeFile(join(root, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n  cache:\n    image: \"redis:7\"\n  app:\n    build: .\n");
  commitAll(root, "code");
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).stdout.trim();
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: branch } });
  const drafted = kiln(root, ["dna", "infra", "--out", ".kiln/tmp/infra.json"]);
  assert.equal(drafted.status, 0, drafted.stderr);
  const draft = JSON.parse(readFileSync(join(root, ".kiln/tmp/infra.json"), "utf8"));
  const [backend, frontend, ...images] = draft.upsert.services;
  assert.deepEqual([backend.kind, backend.root_paths, frontend.kind, frontend.root_paths], ["BACKEND", ["server"], "FRONTEND", ["web"]], "one repository is one service, with the front end split out by name");
  assert.deepEqual(images.map(({ id, kind }) => [id, kind]), [["SVC-POSTGRES", "DATABASE"], ["SVC-REDIS", "CACHE"]]);
  assert.deepEqual(draft.upsert.surfaces.map(({ kind, primary_paths, service_id }) => [kind, primary_paths[0], service_id]).sort(), [["API", "server/routes.js", backend.id], ["BATCH", "server/jobs.js", backend.id], ["SCREEN", "web/pages/index.tsx", frontend.id]]);
  assert.deepEqual(draft.settings.evidence_sources, [{ id: "root", kind: "SOURCE_CODE", root: "." }]);
  const applied = kiln(root, ["dna", "apply", ".kiln/tmp/infra.json"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readStore(root).data.surfaces.length, 3);
});
