import { Buffer } from "node:buffer";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { canonical } from "../lib/dna/contract.mjs";
import { componentId, componentRoot, derive, serviceOfPath, stripDerived } from "../lib/dna/derive.mjs";
import { jargonHits, runGates } from "../lib/dna/gates.mjs";
import { idScheme, nextId } from "../lib/dna/ids.mjs";
import { applyBatch, checkStore, remapPlan } from "../lib/dna/apply.mjs";
import { readStore, storeDir } from "../lib/dna/store.mjs";
import { classByPath, measure, scanProject, skeletons } from "../lib/dna/scan.mjs";
import { serveExplorer } from "../lib/dna/serve.mjs";
import { lineRanges, rangeGap } from "../lib/dna/footprint.mjs";
import { parseRoster, readManifest, reconcilePanels } from "../lib/dna/reconcile.mjs";
import { recordedPace, sizeLines, workSize } from "../lib/dna/size.mjs";
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
    settings: { project: "slugger", evidence_sources: [{ id: "code", kind: "SOURCE_CODE", root: "." }] },
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
  assert.deepEqual(measure("if (a && b) {\n}\n\n"), { lines: 2, total: 3, branches: 2, density: 1 }, "density reads code lines; a range cites every line");
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

test("DNA scan: Linguist's attributes leave third-party code out, and -linguist-vendored keeps it (D170)", () => {
  const root = scanned();
  writeFile(join(root, "system/core/Router.php"), BRANCHY.replaceAll("export ", "<?php "));
  writeFile(join(root, "public/asset/chart-min.js"), BRANCHY);
  writeFile(join(root, "src/schema.js"), BRANCHY);
  writeFile(join(root, "src/bundle.js"), BRANCHY);
  writeFile(join(root, ".gitattributes"), "system/** linguist-vendored\nvendor/lib.js -linguist-vendored\n");
  commitAll(root, "third party");
  writeFile(join(root, ".git/info/attributes"), "src/schema.js linguist-generated\nsrc/bundle.js linguist-vendored=1\n");
  const config = { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: "main" } };
  const classOf = Object.fromEntries(scanProject(root, { config, ledger: {} }).files.map((file) => [file.path, file.class]));
  assert.equal(classOf["system/core/Router.php"], "OTHER", "linguist-vendored in .gitattributes");
  assert.equal(classOf["src/schema.js"], "OTHER", "linguist-generated in the never-committed .git/info/attributes");
  assert.equal(classOf["public/asset/chart-min.js"], "OTHER", "Linguist's -min.js pattern");
  assert.equal(classOf["src/bundle.js"], "OTHER", "as Linguist reads it, any value but false is true");
  assert.equal(classOf["vendor/lib.js"], "CANDIDATE", "-linguist-vendored keeps what the built-in pattern drops");
  assert.equal(classOf["src/price.js"], "CANDIDATE");
  writeConfig(root, config);
  assert.match(kiln(root, ["dna", "scan"]).stdout, /left out as vendored or generated: 4 — mark more with linguist-vendored/);
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
  assert.throws(() => applyBatch(root, { batch: { scan: { commits: { root: head }, files: ["src/missing.js"] } }, today: TODAY, config }), /has no file src\/missing\.js/);
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

test("DNA gates: a finding owned twice, or an rd_id naming no finding, fails; one owned by nothing is a warning", () => {
  const data = { ...empty(), capabilities: [{ id: "DOM-TXT-01" }], findings: [{ id: "RD-0001" }, { id: "RD-0002" }, { id: "RD-0003" }], features: [{ id: "DOM-TXT-01-01", capability_id: "DOM-TXT-01", rd_ids: ["RD-0001", "RD-0009"] }], excluded: [{ id: "EXC-1", rd_ids: ["RD-0001"] }] };
  const report = runGates({ data, settings: {} });
  const failed = report.failed.map((result) => result.label);
  assert.ok(failed.includes("a finding belongs to at most one feature or excluded entry"));
  assert.ok(failed.includes("rd_ids resolve to findings"));
  assert.deepEqual(report.warnings.find((result) => result.label.startsWith("findings no feature")).warn, "2/3");
});

// ------------------------------------------------------------------ D155/D156 review round

function scanFixture(files) {
  const root = project();
  for (const [path, body] of Object.entries(files)) writeFile(join(root, path), body);
  commitAll(root, "code");
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const config = { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: branch } };
  writeConfig(root, config);
  return { root, config };
}

function git(root, args, input) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8", input });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test("DNA scan: a tree entry named `..` is never read or written, wherever the tree came from", () => {
  const { root, config } = scanFixture({ "src/price.js": BRANCHY });
  const blob = git(root, ["hash-object", "-w", "--stdin"], BRANCHY);
  const inner = git(root, ["mktree"], `100644 blob ${blob}\tPWNED.js\n`);
  const tree = git(root, ["mktree"], `040000 tree ${inner}\t..\n100644 blob ${blob}\tok.js\n`);
  const commit = git(root, ["commit-tree", tree, "-m", "hostile"]);
  git(root, ["update-ref", `refs/heads/${config.vcs.integration_branch}`, commit]);
  const { files } = scanProject(root, { config, ledger: {} });
  assert.deepEqual(files.map((file) => file.path), ["ok.js"]);
});

test("DNA scan: chunks cover every line of a file, blank ones included", () => {
  const body = Array.from({ length: 1000 }, (_, index) => (index % 3 === 0 ? "" : `if (x${index}) y();`)).join("\n");
  const { root } = scanFixture({ "src/big.js": `${body}\n` });
  kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r"]);
  const [entry] = JSON.parse(readFileSync(join(root, ".kiln/tmp/r/scan-001.json"), "utf8")).read;
  assert.equal(entry.lines, 1000);
  assert.deepEqual(entry.chunks.at(-1), [801, 1000]);
});

test("DNA scan: a module that is not its own checkout is refused, not scanned as its parent", () => {
  const { root, config } = scanFixture({ "mods/sub/a.js": BRANCHY });
  assert.throws(() => scanProject(root, { config: { ...config, repo: { modules: { sub: "mods/sub" } } }, ledger: {} }), /not a checkout of its own/);
});

test("DNA scan: names with a tab or a newline, and a file that became a directory, are read without a crash", () => {
  const { root } = scanFixture({ "src/tab\tname.js": BRANCHY, "src/new\nline.js": BRANCHY, "src/d.js": BRANCHY });
  rmSync(join(root, "src/d.js"));
  mkdirSync(join(root, "src/d.js"));
  const listed = kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r"]);
  assert.equal(listed.status, 0, listed.stderr);
  const paths = JSON.parse(readFileSync(join(root, ".kiln/tmp/r/scan-001.json"), "utf8")).read.map((entry) => entry.path).sort();
  assert.deepEqual(paths, ["src/d.js", "src/new\nline.js", "src/tab\tname.js"]);
});

test("DNA scan: a snapshot copy is the blob byte for byte, whatever its encoding", () => {
  const latin = Buffer.from("// caf\xe9\nif (a) b(); if (c) d();\n", "latin1");
  const { root } = scanFixture({});
  writeFileSync(join(root, "src.js"), latin);
  commitAll(root, "latin");
  writeFileSync(join(root, "src.js"), "// changed\n");
  kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r"]);
  const [entry] = JSON.parse(readFileSync(join(root, ".kiln/tmp/r/scan-001.json"), "utf8")).read;
  assert.deepEqual(readFileSync(join(root, entry.at)), latin);
});

test("DNA apply: a malformed scan section is refused in words, a directory is not a file, and a deleted path leaves the ledger", () => {
  const { root, config } = scanFixture({ "src/price.js": BRANCHY, "src/other.js": BRANCHY });
  const head = git(root, ["rev-parse", "HEAD"]);
  for (const scan of [{ commits: { root: head }, files: "src/price.js" }, { commits: "x", files: [] }]) {
    assert.throws(() => applyBatch(root, { batch: { scan }, today: TODAY, config }), (error) => error.constructor.name === "DnaError");
  }
  assert.throws(() => applyBatch(root, { batch: { scan: { commits: { root: head }, files: ["src"] } }, today: TODAY, config }), /has no file src/);
  applyBatch(root, { batch: { scan: { commits: { root: head }, files: ["src/price.js", "src/other.js"] } }, today: TODAY, config });
  git(root, ["rm", "-q", "src/other.js"]);
  commitAll(root, "delete");
  applyBatch(root, { batch: { scan: { commits: { root: git(root, ["rev-parse", "HEAD"]) }, files: [] } }, today: TODAY, config });
  assert.deepEqual(Object.keys(readStore(root).scanned), ["src/price.js"]);
});

test("kiln dna scan: --out follows symlinks to where they lead, resolves from the project root, and --limit must be a count", () => {
  const { root } = scanFixture({ "src/price.js": BRANCHY });
  const outside = tempRoot("kiln-outside-");
  mkdirSync(join(root, ".kiln/tmp"), { recursive: true });
  symlinkSync(outside, join(root, ".kiln/tmp/link"));
  assert.match(kiln(root, ["dna", "scan", "--out", ".kiln/tmp/link/r"]).stderr, /--out must be under/);
  const fromSource = spawnSync(process.execPath, [new URL("../bin/kiln.mjs", import.meta.url).pathname, "dna", "scan", "--out", ".kiln/tmp/r"], { cwd: join(root, "src"), encoding: "utf8" });
  assert.equal(fromSource.status, 0, fromSource.stderr);
  assert.ok(existsSync(join(root, ".kiln/tmp/r/scan-001.json")));
  for (const limit of ["0", "abc"]) assert.match(kiln(root, ["dna", "scan", "--limit", limit]).stderr, /--limit takes a whole number/);
});

test("kiln dna infra: one service per image, no exporters, whole-word front ends, and the project's own code beside its modules", () => {
  const { root } = scanFixture({
    "webhooks/handler.js": BRANCHY,
    "index.js": BRANCHY,
    "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  metrics:\n    image: prom/mysqld-exporter\n",
    "docker-compose.dev.yml": "services:\n  db:\n    image: docker.io/library/postgres:16@sha256:abc\n",
  });
  const draft = JSON.parse(kiln(root, ["dna", "infra"]).stdout);
  assert.deepEqual(draft.upsert.services.map(({ kind, root_paths, name }) => [kind, root_paths ?? name]), [["BACKEND", ["index.js", "webhooks"]], ["DATABASE", "postgres"]]);
});

test("DNA surface rules: routes, not HTTP clients; pages, not components; a CI3 web controller is not a batch", () => {
  const { root } = scanFixture({
    "src/client.js": "api.get('/users'); app.get('port');\n",
    "src/server.js": "app.get('/orders', list);\n",
    "src/components/pages/Card.tsx": "export default () => null;\n",
    "pages/index.js": "export default () => null;\n",
    "app/dash/page.js": "export default () => null;\n",
    "src/routes/shop/+page.svelte": "<p/>\n",
    "src/orders.controller.ts": "@Controller('orders')\nexport class Orders {\n  @Get()\n  list() {}\n}\n",
  });
  const surfaces = JSON.parse(kiln(root, ["dna", "infra"]).stdout).upsert.surfaces.map(({ kind, primary_paths }) => `${kind} ${primary_paths[0]}`).sort();
  assert.deepEqual(surfaces, ["API src/orders.controller.ts", "API src/server.js", "SCREEN app/dash/page.js", "SCREEN pages/index.js", "SCREEN src/routes/shop/+page.svelte"]);

  const ci3 = scanFixture({
    "application/controllers/Web.php": "<?php class Web { function index() { if (is_cli()) show_404(); $this->load->view('home', ['x' => json_encode([])]); } }\n",
    "application/controllers/Job.php": "<?php class Job { function run() { if (!is_cli()) exit; } }\n",
    "application/modules/shop/controllers/Cart.php": "<?php class Cart { function add() { $this->output->set_content_type('application/json'); } }\n",
  });
  writeConfig(ci3.root, { ...ci3.config, stack: { id: "php-ci3", cmd: {} } });
  const kinds = JSON.parse(kiln(ci3.root, ["dna", "infra"]).stdout).upsert.surfaces.map(({ kind, primary_paths }) => `${kind} ${primary_paths[0]}`).sort();
  assert.deepEqual(kinds, ["API application/modules/shop/controllers/Cart.php", "BATCH application/controllers/Job.php", "SCREEN application/controllers/Web.php"]);
});

// ------------------------------------------------------------------ drift and update (D22, D80, D82)

/** A project whose integration branch lives on a bare origin, scanned once and pinned. */
function pinnedWithOrigin() {
  const { root, config } = scanFixture({ "src/price.js": BRANCHY, "src/old.js": BRANCHY });
  const branch = config.vcs.integration_branch;
  const origin = tempRoot("kiln-origin-");
  git(origin, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["push", "-q", "origin", branch]);
  git(root, ["fetch", "-q", "origin"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  applyBatch(root, { batch: { scan: { commits: { root: head }, files: ["src/price.js", "src/old.js"] }, upsert: { findings: [
    { category: "CODE_ONLY", proposition: "A VIP order ships free", module: "src/price.js" },
    { category: "CODE_ONLY", proposition: "Old orders are archived", module: "src/old.js" },
  ] } }, today: TODAY, config });
  return { root, config, branch, origin };
}

test("kiln dna drift: nothing moved is none; a merged change is counted with the findings it puts in doubt", () => {
  const { root, branch } = pinnedWithOrigin();
  assert.match(kiln(root, ["dna", "drift"]).stdout, /0 changed · 0 new candidate\(s\) · 0 deleted — none/);
  writeFile(join(root, "src/price.js"), `${BRANCHY}if (a) b(); if (c) d();\n`);
  writeFile(join(root, "src/new.js"), BRANCHY);
  git(root, ["rm", "-q", "src/old.js"]);
  commitAll(root, "merged work");
  git(root, ["push", "-q", "origin", branch]);
  git(root, ["update-ref", `refs/remotes/origin/${branch}`, `${git(root, ["rev-parse", "HEAD"])}~1`]);
  const drift = kiln(root, ["dna", "drift"]).stdout;
  assert.match(drift, /1 changed · 1 new candidate\(s\) · 1 deleted — small/, "it fetched: origin was rewound locally and the fetch brought it forward");
  assert.match(drift, /changed: src\/price\.js \(RD-0001\)/);
  assert.match(drift, /deleted: src\/old\.js \(RD-0002\)/);
});

test("kiln dna drift: a failed fetch is reported and never counted as no drift", () => {
  const { root } = pinnedWithOrigin();
  git(root, ["remote", "set-url", "origin", join(tempRoot("kiln-gone-"), "missing.git")]);
  const drift = kiln(root, ["dna", "drift"]).stdout;
  assert.match(drift, /root: git fetch origin \S+ failed/);
  assert.match(drift, /— unknown: a fetch failed/);
});

test("kiln dna update: refused on a store with no findings, and a changed file's skeleton carries what it was", () => {
  const empty = project();
  applyBatch(empty, { batch: { settings: { project: "x" } }, today: TODAY });
  assert.match(kiln(empty, ["dna", "update"]).stderr, /a first build is \/kiln dna init/);

  const { root, branch } = pinnedWithOrigin();
  const before = readStore(root).scanned["src/price.js"];
  writeFile(join(root, "src/price.js"), `${BRANCHY}if (a) b(); if (c) d();\n`);
  commitAll(root, "merged work");
  git(root, ["push", "-q", "origin", branch]);
  const updated = kiln(root, ["dna", "update", "--out", ".kiln/tmp/u"]);
  assert.equal(updated.status, 0, updated.stderr);
  const updateSkeleton = JSON.parse(readFileSync(join(root, ".kiln/tmp/u/update-001.json"), "utf8"));
  assert.ok(Number.isFinite(updateSkeleton.scan.started), "an update round is timed like a scan round (D177)");
  const [entry] = updateSkeleton.read;
  assert.deepEqual([entry.path, entry.was, entry.cites], ["src/price.js", before, ["RD-0001"]]);
});

// ------------------------------------------------------------------ consumers (tier 1)

test("kiln blast: with a store, tier 1 names files through the features that own them, marks what changed since, and both tiers are recorded", () => {
  const { root, config } = scanFixture({ "src/credit.js": BRANCHY, "src/notes.js": "// refund policy lives elsewhere\n" });
  const head = git(root, ["rev-parse", "HEAD"]);
  applyBatch(root, { batch: {
    scan: { commits: { root: head }, files: ["src/credit.js"] },
    upsert: {
      domains: [{ id: "DOM-BIL", key: "d", name: "Billing" }],
      capabilities: [{ key: "c", domain_id: "@d", name: "Credits" }],
      features: [{ capability_id: "@c", domain_id: "@d", name: "Refund a paid order", rd_ids: ["@f"] }],
      findings: [{ key: "f", category: "CODE_ONLY", proposition: "A VIP order ships free", module: "src/credit.js" }],
    },
  }, today: TODAY, config });
  writeFile(join(root, "src/credit.js"), `${BRANCHY}// edited\n`);
  assert.equal(kiln(root, ["open", "w1", "--session", "s"]).status, 0);
  const blast = kiln(root, ["blast", "--for", "w1", "refund"]);
  assert.equal(blast.status, 0, blast.stderr);
  assert.match(blast.stdout, /1\tsrc\/notes\.js/, "tier 0 greps the word");
  assert.match(blast.stdout, /DNA \(tier 1\)[\s\S]*1\tsrc\/credit\.js\tDOM-BIL-01-01 — changed since the DNA read it/, "tier 1 reaches the file through its feature");
  const state = JSON.parse(readFileSync(join(root, ".kiln/work/w1/state.json"), "utf8"));
  assert.deepEqual(state.knowledge.map(({ tier, files }) => [tier, files]), [[0, ["src/notes.js"]], [1, ["src/credit.js"]]]);
  assert.deepEqual(state.knowledge[1].changed, ["src/credit.js"]);
});

// ------------------------------------------------------------------ the explorer (D83, D84)

function request(url, { method = "GET", host } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const sent = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers: host ? { host } : {} }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    sent.on("error", reject);
    sent.end();
  });
}

test("kiln dna serve: loopback only, behind a token, read-only, and serving the store under the names the page asks for", async () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  const { url, server } = await serveExplorer(root, {});
  try {
    const base = new URL(url);
    assert.equal(base.hostname, "127.0.0.1");
    const page = await request(url);
    assert.equal(page.status, 200);
    assert.match(page.body, /__DNA_EMBED/, "the vendored explorer, as it ships");
    assert.equal((await request(`${url}laneflow.js`)).status, 200);
    assert.match((await request(`${url}_dna_store/findings.jsonl`)).body, /RD-0001/);
    assert.match((await request(`${url}_dna_store/manifest.json`)).body, /"adapter": "kiln"/);
    assert.equal((await request(`${base.origin}/wrongtoken/explorer.html`)).status, 404);
    assert.equal((await request(`${url}_dna_store/settings.json`)).status, 404, "only the contract's files");
    assert.equal((await request(`${url}_dna_store/..%2F..%2Fconfig.json`)).status, 404);
    assert.equal((await request(`${url}%E0%A4%A`)).status, 400);
    assert.equal((await request(url, { method: "POST" })).status, 405);
    assert.equal((await request(url, { host: `evil.example:${base.port}` })).status, 403, "a DNS-rebound name is refused");
  } finally {
    server.close();
  }
});

test("kiln dna serve: with no store there is nothing to serve, and an idle server stops itself", async () => {
  assert.match(kiln(project(), ["dna", "serve"]).stderr, /No DNA store to show yet/);
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  const { server } = await serveExplorer(root, { idleMs: 50 });
  await new Promise((resolve) => server.on("close", resolve));
});

test("the vendored explorer renders both trees of a store kiln wrote, with no console error", () => {
  const root = project();
  const batch = seedBatch();
  batch.upsert.flows = [{ key: "fl", name: "Publish a post", trigger: "An editor has a draft", outcome: "The post is live" }];
  batch.upsert.stages = [{ key: "st", flow_id: "@fl", name: "Drafting" }];
  batch.upsert.processes = [{ flow_id: "@fl", stage_id: "@st", name: "Name the post", key: "p" }];
  batch.upsert.edges = [{ from: "@p", to: "@feat", kind: "FEATURE_PROCESS" }];
  applyBatch(root, { batch, today: TODAY });
  const store = Object.fromEntries(["domains", "capabilities", "features", "excluded", "findings", "flows", "stages", "processes", "edges", "services", "surfaces", "components", "updates", "intakes", "releases", "debts"].map((name) => [name, readFileSync(join(storeDir(root), `${name}.jsonl`), "utf8")]));
  const payload = join(root, ".kiln", "tmp", "embed.json");
  writeFile(payload, JSON.stringify({ store, diagrams: {}, manifest: JSON.parse(readFileSync(join(storeDir(root), "manifest.json"), "utf8")), exported_at: "test", source: "kiln" }));
  const harness = new URL("./helpers/explorer-harness.mjs", import.meta.url).pathname;
  const page = new URL("../vendor/dna-explorer/explorer.html", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [harness, page, payload], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const { rendered: [catalog, processes], errs } = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.ok(catalog > 0 && processes > 0, `rendered catalog ${catalog}b, process ${processes}b`);
  assert.deepEqual(errs, []);
});

// ------------------------------------------------------------------ D157–D160 review round

test("DNA ids: an excluded entry gets a counted id, and a counter past 99 grows a digit without failing its own gate", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  const plan = applyBatch(root, { batch: { upsert: { excluded: [{ catalog: "UX", name: "Buttons", disposition: "generic UI", rd_ids: ["RD-0002"] }], features: [{ id: "DOM-TXT-01-01", rd_ids: ["RD-0001"] }] } }, today: TODAY });
  assert.equal(plan.assigned.find((each) => each.entity === "excluded").id, "EXC-001");
  applyBatch(root, { batch: { upsert: { features: [{ id: "DOM-TXT-01-99", capability_id: "DOM-TXT-01", name: "Ninety-nine" }] } }, today: TODAY });
  const next = applyBatch(root, { batch: { upsert: { features: [{ capability_id: "DOM-TXT-01", name: "One hundred" }] } }, today: TODAY });
  assert.equal(next.assigned[0].id, "DOM-TXT-01-100");
});

test("D174: a citation that does not resolve is refused at apply, and one that does is written", () => {
  const root = scanned();
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: "main" } });
  kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r1"]);
  const path = join(root, ".kiln/tmp/r1/scan-001.json");
  const skeleton = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual([skeleton.read[0].src, skeleton.read[0].ref], ["root", "src/price.js"], "the skeleton hands over what a citation copies");
  const cite = (evidence) => ({ category: "CODE_ONLY", proposition: "A VIP order ships free", module: "src/price.js", evidence: [evidence] });
  const bad = [
    [{ src: "root", ref: "price.js", loc: "L2" }, /root at \w+ has no file price\.js/],
    [{ src: "root", ref: "src/price.js", loc: "L2-3" }, /loc "L2-3" is not L<from> or L<from>-L<to>/],
    [{ src: "root", ref: "src/price.js", loc: "L3-L2" }, /runs backwards/],
    [{ src: "root", ref: "src/price.js", loc: "L2-L99" }, /runs past the 6 line\(s\) of src\/price\.js/],
    [{ src: "AdminPage", ref: "src/price.js", loc: "L2" }, /src "AdminPage" is neither a repository \(root\)/],
    [{ ref: "src/nope.js", loc: "L9-L2" }, /a finding's evidence is \{ src, ref, loc \}/],
    ["src/nope.js:L999", /a finding's evidence is \{ src, ref, loc \}/],
  ];
  for (const [evidence, reason] of bad) {
    writeFile(path, JSON.stringify({ ...skeleton, upsert: { findings: [cite(evidence)] } }));
    const refused = kiln(root, ["dna", "apply", ".kiln/tmp/r1/scan-001.json"]);
    assert.equal(refused.status, 1, JSON.stringify(evidence));
    assert.match(refused.stderr, reason);
  }
  assert.equal(existsSync(join(root, ".kiln/dna/store")), false, "a refused batch writes nothing");
  const docCited = { ...cite({ src: "spec", ref: "pricing.md", loc: "#vip" }), key: "doc" };
  writeFile(path, JSON.stringify({ ...skeleton, settings: { evidence_sources: [{ id: "spec", kind: "DOCUMENT" }] }, upsert: { findings: [cite({ src: "root", ref: "src/price.js", loc: "L2-L2" }), docCited] } }));
  const applied = kiln(root, ["dna", "apply", ".kiln/tmp/r1/scan-001.json"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /RD-0002 ← doc/, "a document source keeps its own kind of anchor");
});

test("D175: a record carrying a credential is refused, and the refusal never repeats the value", () => {
  const root = project();
  const batch = join(root, ".kiln", "tmp", "batch.json");
  const awsKey = `AKIA${"Z7Q2WXKD4PBR3M5N"}`;
  const pem = `-----BEGIN RSA PRIVATE ${"KEY"}-----\n${"M".repeat(64)}\n-----END RSA PRIVATE ${"KEY"}-----`;
  const stripe = `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`;
  const gcp = `AIza${"SyD-9tSrke72PouQMnMX7mB2EFdXK13h8xA"}`;
  const leaksAs = [
    [`'key' => '${awsKey}'`, "aws-access-token"],
    [pem, "private-key"],
    [`const key = "${stripe}";`, "stripe-access-token"],
    [`apiKey: "${gcp}"`, "gcp-api-key"],
    [`$a = 1;\n${awsKey}`, "aws-access-token"],
    [`\t${awsKey}`, "aws-access-token"],
  ];
  for (const [quote, rule] of leaksAs) {
    const leaking = seedBatch();
    leaking.upsert.findings[0].evidence[0].quote = quote;
    writeFile(batch, JSON.stringify(leaking));
    const refused = kiln(root, ["dna", "apply", batch]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`f1: ${rule}`));
    assert.doesNotMatch(refused.stderr, /Z7Q2WXKD4PBR3M5N|MMMMMMMM|4eC39Hq|SyD-9tS/);
  }
  const inSettings = seedBatch();
  inSettings.settings.note = `token ${awsKey}`;
  writeFile(batch, JSON.stringify(inSettings));
  assert.match(kiln(root, ["dna", "apply", batch]).stderr, /settings: aws-access-token/, "settings.json is committed too");
  const quoted = seedBatch();
  quoted.upsert.findings[0].evidence[0].quote = `'key' => getenv('AWS_KEY') // AKIA prefix expected, e.g. AKIA${"IOSFODNN7EXAMPLE"}`;
  writeFile(batch, JSON.stringify(quoted));
  assert.equal(kiln(root, ["dna", "apply", batch]).status, 0, "a name, a prefix, or AWS's documentation key is not a credential");
});

test("D176: dna infra drafts the project's own components as CUSTOM, and a declared list is left alone", () => {
  const root = scanned();
  writeConfig(root, { ...DEFAULTS, vcs: { ...DEFAULTS.vcs, integration_branch: "main" } });
  kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r1"]);
  const path = join(root, ".kiln/tmp/r1/scan-001.json");
  const skeleton = JSON.parse(readFileSync(path, "utf8"));
  skeleton.upsert.findings.push({ category: "CODE_ONLY", proposition: "A VIP order ships free", module: "src/price.js", evidence: [{ src: "root", ref: "src/price.js", loc: "L2" }] });
  writeFile(path, JSON.stringify(skeleton));
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/r1/scan-001.json"]).status, 0);
  assert.equal(readStore(root).data.components[0].origin, "VENDOR", "the source's default before anything is declared");

  assert.equal(kiln(root, ["dna", "infra", "--out", ".kiln/tmp/infra.json"]).status, 0);
  const draft = JSON.parse(readFileSync(join(root, ".kiln/tmp/infra.json"), "utf8"));
  assert.deepEqual(draft.settings.components, { custom: [readStore(root).data.components[0].name] });
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/infra.json"]).status, 0);
  assert.equal(readStore(root).data.components[0].origin, "CUSTOM");

  writeFile(join(root, ".kiln/tmp/later.json"), JSON.stringify({ upsert: { findings: [{ category: "CODE_ONLY", proposition: "Customer names are listed in a fixed order", module: "src/names.js", evidence: [{ src: "root", ref: "src/names.js", loc: "L1" }] }] } }));
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/later.json"]).status, 0);
  const again = kiln(root, ["dna", "infra", "--out", ".kiln/tmp/infra-2.json"]);
  assert.equal(JSON.parse(readFileSync(join(root, ".kiln/tmp/infra-2.json"), "utf8")).settings.components, undefined, "what the person declared is not redrafted");
  assert.match(again.stdout, /Not in components\.custom, so read as VENDOR: src\/names\.js/, "a root found later is named, not added");
});

test("D178: citations already in a store are warned about at its pins, and recite fixes only the mechanical ones", () => {
  const root = initRepo(tempRoot("kiln-dna-"));
  writeFile(join(root, "README.md"), "x\n");
  commitAll(root, "init");
  const admin = join(root, "Admin");
  writeFile(join(admin, "app/price.php"), BRANCHY.replaceAll("export ", "<?php "));
  initRepo(admin);
  commitAll(admin, "module");
  writeConfig(root, { ...DEFAULTS, repo: { kind: "multi", root: null, modules: { admin: "Admin" } }, vcs: { ...DEFAULTS.vcs, integration_branch: "main" } });
  kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r1"]);
  const path = join(root, ".kiln/tmp/r1/scan-001.json");
  const skeleton = JSON.parse(readFileSync(path, "utf8"));
  const finding = (proposition, loc) => ({ category: "CODE_ONLY", proposition, module: "Admin/app/price.php", evidence: [{ src: "admin", ref: "app/price.php", loc }] });
  skeleton.upsert.findings.push(finding("A VIP order ships free", "L2"), finding("A large order with a coupon costs 5", "L3"), finding("An order line marked free costs 1", "L4"));
  writeFile(path, JSON.stringify(skeleton));
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/r1/scan-001.json"]).status, 0);
  assert.doesNotMatch(kiln(root, ["dna", "check"]).stdout, /citations resolve/);

  const findings = join(root, ".kiln/dna/store/findings.jsonl");
  writeFile(findings, readFileSync(findings, "utf8").split("\n").map((line) => line
    .replace('"src":"admin","ref":"app/price.php","loc":"L2"', '"src":"Admin","ref":"Admin/app/price.php","loc":"L2-3"')
    .replace('"src":"admin","ref":"app/price.php","loc":"L3"', '"src":"Admin","ref":"Admin/app/gone.php","loc":"L3"')).join("\n"));
  const checked = kiln(root, ["dna", "check"]);
  assert.equal(checked.status, 0, "old debt is reported, not blocking");
  assert.match(checked.stdout, /citations resolve at the store's pinned commits.*2 citation\(s\) in 2 record\(s\) do not — `kiln dna recite`/, "one unit named, so a record count from recite is not read as citations left over");

  const dry = kiln(root, ["dna", "recite"]);
  assert.match(dry.stdout, /needs a reader — RD-0002: admin at \w+ has no file app\/gone\.php/);
  assert.match(dry.stdout, /1 record\(s\) would be re-cited: RD-0001\. Nothing written/);
  assert.match(readFileSync(findings, "utf8"), /"src":"Admin"/, "a dry run writes nothing");

  assert.equal(kiln(root, ["dna", "recite", "--apply"]).status, 0);
  assert.equal(readStore(root).data.findings[0].evidence[0].src, "admin");
  assert.deepEqual(readStore(root).data.findings[0].evidence[0], { src: "admin", ref: "app/price.php", loc: "L2-L3" });
  assert.match(kiln(root, ["dna", "check"]).stdout, /1 citation\(s\) in 1 record\(s\) do not/, "what needs a reader is still said");

  writeFile(join(root, ".kiln/tmp/retire.json"), JSON.stringify({ upsert: { excluded: [{ id: "EXC-RETIRED-UPD-0001", catalog: "RETIRED", name: "Retired", disposition: "the file was deleted", rd_ids: ["RD-0002"] }] } }));
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/retire.json"]).status, 0);
  assert.doesNotMatch(kiln(root, ["dna", "check"]).stdout, /citations resolve/, "a retired finding's citation is history");
});

test("D178: a pin this clone lacks, a module not checked out, and a root citation into a module are each handled", () => {
  const root = initRepo(tempRoot("kiln-dna-"));
  writeFile(join(root, "README.md"), "x\n");
  commitAll(root, "init");
  const admin = join(root, "Admin");
  writeFile(join(admin, "app/price.php"), BRANCHY.replaceAll("export ", "<?php "));
  initRepo(admin);
  commitAll(admin, "module");
  writeConfig(root, { ...DEFAULTS, repo: { kind: "multi", root: null, modules: { admin: "Admin" } }, vcs: { ...DEFAULTS.vcs, integration_branch: "main" } });
  kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r1"]);
  const path = join(root, ".kiln/tmp/r1/scan-001.json");
  const skeleton = JSON.parse(readFileSync(path, "utf8"));
  skeleton.upsert.findings.push({ category: "CODE_ONLY", proposition: "A VIP order ships free", module: "Admin/app/price.php", evidence: [{ src: "admin", ref: "app/price.php", loc: "L2" }] });
  writeFile(path, JSON.stringify(skeleton));
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/r1/scan-001.json"]).status, 0);
  const findings = join(root, ".kiln/dna/store/findings.jsonl");
  writeFile(findings, readFileSync(findings, "utf8").replace('"src":"admin","ref":"app/price.php"', '"src":"root","ref":"Admin/app/price.php"'));
  assert.match(kiln(root, ["dna", "recite", "--apply"]).stdout, /Re-cited 1 record/, "a root citation into a module moves to the module");
  assert.deepEqual(readStore(root).data.findings[0].evidence[0], { src: "admin", ref: "app/price.php", loc: "L2" });

  const manifestPath = join(root, ".kiln/dna/store/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFile(manifestPath, JSON.stringify({ ...manifest, source_pins: { ...manifest.source_pins, admin: "0123456789abcdef0123456789abcdef01234567" } }));
  const checked = kiln(root, ["dna", "check"]).stdout;
  assert.match(checked, /pinned commits are in this clone — admin 0123456789ab missing — run git fetch/);
  assert.doesNotMatch(checked, /citations resolve at the store's pinned commits —/, "judged at the tip, a good citation is not called broken");

  renameSync(join(admin, ".git"), join(root, "admin-git"));
  const status = kiln(root, ["dna"]);
  assert.equal(status.status, 0, "status survives a module that is not checked out");
  assert.match(kiln(root, ["dna", "check"]).stdout, /citations resolve at the store's pinned commits — not judged — module admin/);
});

test("kiln dna update: a module's changed file says which repository, path and commit to diff it in", () => {
  const { root, config } = scanFixture({});
  const module = join(root, "mods/sub");
  mkdirSync(module, { recursive: true });
  initRepo(module);
  writeFile(join(module, "lib/pay.js"), BRANCHY);
  commitAll(module, "module");
  git(module, ["branch", "-M", config.vcs.integration_branch]);
  const moduleConfig = { ...config, repo: { modules: { sub: "mods/sub" } } };
  const { files, repos } = scanProject(root, { config: moduleConfig, ledger: {} });
  const [skeleton] = skeletons(root, { repos, groups: [files.filter((file) => file.path === "mods/sub/lib/pay.js")] });
  assert.deepEqual([skeleton.read[0].repo, skeleton.read[0].src, skeleton.read[0].ref, skeleton.read[0].commit], ["mods/sub", "sub", "lib/pay.js", git(module, ["rev-parse", "HEAD"])]);
});

test("kiln dna drift: a candidate the bootstrap has not read yet is not drift", () => {
  const { root } = pinnedWithOrigin();
  const head = git(root, ["rev-parse", "HEAD"]);
  writeFile(join(root, "src/late.js"), BRANCHY);
  commitAll(root, "late");
  const config = JSON.parse(readFileSync(join(root, ".kiln/config.json"), "utf8"));
  git(root, ["push", "-q", "origin", config.vcs.integration_branch]);
  applyBatch(root, { batch: { scan: { commits: { root: git(root, ["rev-parse", "HEAD"]) }, files: [] } }, today: TODAY, config });
  assert.notEqual(readStore(root).manifest.source_pins.root, head, "the pin moved to the tip, where src/late.js already existed");
  const drift = kiln(root, ["dna", "drift"]).stdout;
  assert.match(drift, /0 changed · 0 new candidate\(s\) · 0 deleted — none/);
  assert.match(drift, /1 candidate\(s\) the bootstrap has not read yet/);
});

test("kiln dna drift: an unknown verdict never prints its counts as a clean zero", () => {
  const { root } = pinnedWithOrigin();
  git(root, ["remote", "set-url", "origin", join(tempRoot("kiln-gone-"), "missing.git")]);
  assert.match(kiln(root, ["dna", "drift"]).stdout, /as of the last fetch, 0 changed/);
});

test("kiln blast: a store that cannot be read loses tier 1 only, and an excluded owner is not shown as a feature", () => {
  const { root, config } = scanFixture({ "src/credit.js": BRANCHY });
  applyBatch(root, { batch: { upsert: { findings: [{ key: "f", category: "CODE_ONLY", proposition: "A refund is refused after the window", module: "src/credit.js" }], excluded: [{ catalog: "UX", name: "Generic", rd_ids: ["@f"] }] } }, today: TODAY, config });
  const shown = kiln(root, ["blast", "refund"]).stdout;
  assert.match(shown, /1\tsrc\/credit\.js\tRD-0001/, "no feature column entry for EXC-001");
  writeFileSync(join(storeDir(root), "debts.jsonl"), "{not json\n");
  const broken = kiln(root, ["blast", "refused"]);
  assert.equal(broken.status, 0);
  assert.match(broken.stderr, /DNA \(tier 1\) unavailable/);
});

test("kiln dna serve: a store rewritten mid-request answers 503, a busy port is a sentence, and the page's export can read itself", async () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  const { url, server } = await serveExplorer(root, {});
  try {
    assert.equal((await request(`${url}explorer-v2.html`)).status, 200, "the Export button's fallback name at /<token>/");
    renameSync(storeDir(root), `${storeDir(root)}.moved`);
    assert.equal((await request(`${url}_dna_store/manifest.json`)).status, 503);
    renameSync(`${storeDir(root)}.moved`, storeDir(root));
    const busy = kiln(root, ["dna", "serve", "--port", new URL(url).port]);
    assert.match(busy.stderr, /port \d+ is in use/);
    assert.doesNotMatch(busy.stderr, /bug in kiln/);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------ run size and recorded pace (D161)

test("DNA size: exact counts always, and a pace only from this project's own recorded rounds", () => {
  const files = [{ total: 400 }, { total: 500 }, { total: 30 }];
  assert.deepEqual(workSize(files), { files: 3, lines: 930, skeletons: 2, waves: 1 });
  assert.equal(recordedPace({ updates: [{ ext: { metrics: { lines_scanned: 0, minutes: 3 } } }] }), null, "a round with nothing measured is no pace");
  const [size, none] = sizeLines(files, {});
  assert.match(size, /3 file\(s\) · 930 line\(s\) · 2 skeleton\(s\) · 1 wave\(s\)/);
  assert.match(none, /no round of this project has been recorded yet, so there is no time estimate/);
  const updates = [{ ext: { metrics: { lines_scanned: 600, minutes: 10, cost_usd: 1.2 } } }, { ext: { metrics: { lines_scanned: 300, minutes: 5 } } }];
  assert.deepEqual(recordedPace({ updates }), { rounds: 2, linesPerMinute: 60, costPerKiloLine: 2 });
  assert.match(sizeLines(files, { updates })[1], /about 16 min, about \$1\.86 — taken from past rounds, not a promise/);
});

test("D177: a round's pace is its lines over its wall time, with skeletons read side by side counted once", () => {
  const rounds = [
    { started: 1000, finished: 1300, files: ["a", "b", "c"], lines: 600 },
    { started: 1000, finished: 1600, files: ["d", "e", "f"], lines: 600 },
    { started: 5000, finished: 5300, files: ["g", "h"], lines: 300 },
  ];
  assert.deepEqual(recordedPace({ rounds }), { rounds: 2, linesPerMinute: 1500 / 15, costPerKiloLine: null }, "10 min and 5 min, not 5 + 10 + 5");
  const updates = [{ ext: { metrics: { lines_scanned: 1500, minutes: 60, cost_usd: 3 } } }];
  assert.deepEqual(recordedPace({ rounds, updates }), { rounds: 2, linesPerMinute: 100, costPerKiloLine: 2 }, "timed rounds win; an update still supplies cost");
});

test("D177: a bootstrap cut off after one round already has a pace for the next session", () => {
  const { root } = scanFixture({ "src/price.js": BRANCHY, "src/tax.js": BRANCHY });
  assert.match(kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r1", "--limit", "1"]).stdout, /no round of this project has been recorded yet/);
  const path = join(root, ".kiln/tmp/r1/scan-001.json");
  const skeleton = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(Math.abs(skeleton.scan.started - Date.now() / 1000) < 60, "kiln stamps when the round was written out");
  writeFile(path, JSON.stringify({ ...skeleton, scan: { ...skeleton.scan, started: skeleton.scan.started - 120 } }));
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/r1/scan-001.json"]).status, 0);
  assert.equal(readStore(root).rounds.length, 1);
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/r1/scan-001.json"]).status, 0);
  assert.equal(readStore(root).rounds.length, 1, "a skeleton applied again is the same work, timed once");
  assert.match(kiln(root, ["dna", "scan"]).stdout, /at the pace of 1 recorded round\(s\): about \d+ min/);

  kiln(root, ["dna", "scan", "--out", ".kiln/tmp/r2"]);
  const stale = JSON.parse(readFileSync(join(root, ".kiln/tmp/r2/scan-001.json"), "utf8"));
  writeFile(join(root, ".kiln/tmp/r2/scan-001.json"), JSON.stringify({ ...stale, scan: { ...stale.scan, started: stale.scan.started - 3 * 86400 } }));
  assert.equal(kiln(root, ["dna", "apply", ".kiln/tmp/r2/scan-001.json"]).status, 0);
  assert.equal(readStore(root).rounds.length, 1, "a start days back measures a pause, not a round");
});

test("kiln dna scan: says how much is left to read before anything is dispatched", () => {
  const { root } = scanFixture({ "src/price.js": BRANCHY });
  const scan = kiln(root, ["dna", "scan"]).stdout;
  assert.match(scan, /to read: 1 file\(s\) · 6 line\(s\) · 1 skeleton\(s\) · 1 wave\(s\)/);
  assert.match(scan, /there is no time estimate — agree a cap/);
});

// ------------------------------------------------------------------ checkpoints (D162)

test("DNA checkpoint: every write is kept on a ref of its own, with HEAD, the index and branches untouched", () => {
  const root = project();
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const plan = applyBatch(root, { batch: seedBatch(), today: TODAY });
  assert.match(plan.checkpoint.commit, /^[0-9a-f]{40}$/);
  assert.equal(spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(), head);
  assert.equal(spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }).stdout, "", "nothing staged in the user's index");
  const listed = spawnSync("git", ["ls-tree", "-r", "--name-only", plan.checkpoint.commit], { cwd: root, encoding: "utf8" }).stdout;
  assert.match(listed, /^\.kiln\/dna\/store\/findings\.jsonl$/m);
  const second = applyBatch(root, { batch: { upsert: { findings: [{ category: "CODE_ONLY", proposition: "Another rule", module: "src/slug.js" }] } }, today: TODAY });
  assert.equal(spawnSync("git", ["rev-parse", `${second.checkpoint.commit}^`], { cwd: root, encoding: "utf8" }).stdout.trim(), plan.checkpoint.commit, "each checkpoint follows the last");
});

test("kiln dna restore: a store the working tree lost comes back, and one that is there is never overwritten", () => {
  const root = project();
  applyBatch(root, { batch: seedBatch(), today: TODAY });
  assert.match(kiln(root, ["dna", "restore"]).stderr, /already has a store/);
  rmSync(join(root, ".kiln", "dna"), { recursive: true, force: true });
  assert.match(kiln(root, ["dna"]).stdout, /a checkpoint of one exists[\s\S]*kiln dna restore/);
  const restored = kiln(root, ["dna", "restore"]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readStore(root).data.findings.length, 2);
  assert.equal(kiln(root, ["dna", "check"]).status, 0);
});

// ------------------------------------------------------------------ remap (D164)

/** Two domains, three capabilities, features with findings, and a flow whose process serves one of them. */
function remapFixture() {
  const root = project();
  applyBatch(root, { batch: { upsert: {
    domains: [{ id: "DOM-AAA", name: "A" }, { id: "DOM-BBB", name: "B" }],
    capabilities: [{ key: "a1", domain_id: "DOM-AAA", name: "A one", boundary: "not DOM-AAA-02" }, { key: "a2", domain_id: "DOM-AAA", name: "A two" }, { key: "b1", domain_id: "DOM-BBB", name: "B one" }],
    features: [{ key: "fa1", capability_id: "@a1", domain_id: "DOM-AAA", name: "Fa1", rd_ids: ["@r1"] }, { key: "fa2", capability_id: "@a2", domain_id: "DOM-AAA", name: "Fa2", rd_ids: ["@r2"] }, { key: "fb1", capability_id: "@b1", domain_id: "DOM-BBB", name: "Fb1" }],
    findings: [{ key: "r1", proposition: "one", module: "src/a.js" }, { key: "r2", proposition: "two", module: "src/b.js" }],
    flows: [{ key: "fl", name: "Journey" }],
    stages: [{ key: "s1", flow_id: "@fl", name: "First" }, { key: "s2", flow_id: "@fl", name: "Second" }],
    processes: [{ key: "p1", flow_id: "@fl", stage_id: "@s1", name: "Do one", primary_capability_id: "@a1", primary_domain_id: "DOM-AAA" }, { key: "p2", flow_id: "@fl", stage_id: "@s2", name: "Do two", primary_capability_id: "@a2", primary_domain_id: "DOM-AAA" }],
    edges: [{ from: "@p1", to: "@fa1", kind: "FEATURE_PROCESS" }, { from: "@p2", to: "@fa2", kind: "FEATURE_PROCESS" }],
  } }, today: TODAY });
  return root;
}

test("DNA remap: a capability moved to another domain renumbers itself, its features and every reference, without chaining", () => {
  const root = remapFixture();
  const before = readFileSync(join(storeDir(root), "capabilities.jsonl"), "utf8");
  const dry = remapPlan(root, { plan: { capability_moves: [{ capability: "DOM-AAA-01", target_domain: "DOM-BBB" }] }, apply: false });
  assert.deepEqual(Object.fromEntries(dry.changed), { "DOM-AAA-01": "DOM-BBB-02", "DOM-AAA-01-01": "DOM-BBB-02-01", "DOM-AAA-02": "DOM-AAA-01", "DOM-AAA-02-01": "DOM-AAA-01-01" });
  assert.equal(readFileSync(join(storeDir(root), "capabilities.jsonl"), "utf8"), before, "a dry run writes nothing");
  remapPlan(root, { plan: { capability_moves: [{ capability: "DOM-AAA-01", target_domain: "DOM-BBB" }] }, apply: true });
  const { data } = readStore(root);
  const moved = data.capabilities.find((row) => row.id === "DOM-BBB-02");
  assert.deepEqual([moved.domain_id, moved.legacy_capability_id, moved.ext.id_history], ["DOM-BBB", "DOM-AAA-01", ["DOM-AAA-01"]]);
  assert.equal(moved.ext.boundary, "not DOM-AAA-01", "prose naming a renumbered capability follows it");
  const renumbered = data.features.find((row) => row.name === "Fa2");
  assert.deepEqual([renumbered.id, renumbered.capability_id], ["DOM-AAA-01-01", "DOM-AAA-01"], "DOM-AAA-02 became DOM-AAA-01 and was not carried on to DOM-BBB-02");
  const process = data.processes.find((row) => row.name === "Do one");
  assert.deepEqual([process.primary_capability_id, process.primary_domain_id, process.legacy_primary_domain_id], ["DOM-BBB-02", "DOM-BBB", "DOM-AAA"]);
  assert.ok(data.edges.some((edge) => edge.to === "DOM-BBB-02-01" && edge.kind === "FEATURE_PROCESS"));
  assert.equal(data.findings.find((row) => row.id === "RD-0001").feature_id, "DOM-BBB-02-01", "a finding's feature follows through derivation");
  assert.equal(kiln(root, ["dna", "check"]).status, 0);
});

test("DNA remap: the source's refusals — a non-empty delete, an empty new capability, a move twice, a count not conserved", () => {
  const root = remapFixture();
  for (const [plan, reason] of [
    [{ deletes: [{ capability: "DOM-AAA-01" }] }, /not empty/],
    [{ new_capabilities: [{ domain: "DOM-BBB", name: "Hollow", from_features: [] }] }, /has no features/],
    [{ capability_moves: [{ capability: "DOM-AAA-01", target_domain: "DOM-BBB" }, { capability: "DOM-AAA-01", target_domain: "DOM-AAA" }] }, /moved twice/],
    [{ stage_layouts: { "BF-01": { stages: [{ name: "Only", processes: ["BF-01.S1.P1"] }] } } }, /cover the flow's processes exactly/],
  ]) assert.throws(() => remapPlan(root, { plan, apply: true }), reason, JSON.stringify(plan));
  const split = remapPlan(root, { plan: { new_capabilities: [{ domain: "DOM-BBB", name: "Split out", from_features: ["DOM-AAA-01-01"] }], deletes: [] }, apply: true });
  assert.equal(split.changed.get("DOM-AAA-01-01"), "DOM-BBB-02-01");
  assert.ok(readStore(root).data.capabilities.some((row) => row.id === "DOM-AAA-01" && row.name === "A one"), "the emptied capability stays; deleting it is its own decision");
});

test("DNA remap: a stage layout re-lays a flow, keeps a gap stage, and renumbers every process beneath it", () => {
  const root = remapFixture();
  const layout = { "BF-01": { stages: [{ name: "Intake", processes: ["BF-01.S2.P1", "BF-01.S1.P1"] }, { name: "Settlement", note: "nothing pays out yet" }] } };
  const result = remapPlan(root, { plan: { stage_layouts: layout }, apply: true });
  assert.deepEqual([result.changed.get("BF-01.S2.P1"), result.changed.get("BF-01.S1.P1")], ["BF-01.S1.P1", "BF-01.S1.P2"]);
  const { data } = readStore(root);
  assert.deepEqual(data.stages.map((row) => [row.id, row.name, row.gap ?? false]), [["BF-01.S1", "Intake", false], ["BF-01.S2", "Settlement", true]]);
  const two = data.processes.find((row) => row.name === "Do two");
  assert.deepEqual([two.id, two.stage_id, two.legacy_process_id], ["BF-01.S1.P1", "BF-01.S1", "BF-01.S2.P1"]);
  assert.ok(data.edges.some((edge) => edge.from === "BF-01.S1.P2" && edge.to === "DOM-AAA-01-01"), "an edge follows its process");
  assert.equal(kiln(root, ["dna", "check"]).status, 0);
});

// ------------------------------------------------------------------ context footprint (D165)

test("DNA footprint: evidence locators the source reads, plus kiln's L3-L12, and the proximity that tiers a neighbour", () => {
  assert.deepEqual(lineRanges("(lines 174-202)"), [[174, 202]]);
  assert.deepEqual(lineRanges([{ src: "root", ref: "a.js", loc: "L3-L12" }]), [[3, 12]], "kiln's own range form, which the source read as two lines");
  assert.deepEqual(lineRanges("L8-12 and L20"), [[8, 12]], "the first family that matches wins");
  assert.deepEqual(lineRanges("no locator"), []);
  assert.equal(rangeGap([[1, 10]], [[5, 20]]), 0);
  assert.equal(rangeGap([[1, 10]], [[40, 50]]), 30);
  assert.equal(rangeGap([], [[1, 2]]), null);
});

test("kiln dna footprint: neighbours by shared file, stage and typed relation, tiered, for the features named", () => {
  const root = remapFixture();
  applyBatch(root, { batch: { upsert: {
    findings: [{ key: "x", proposition: "three", module: "src/a.js", evidence: [{ src: "root", ref: "src/a.js", loc: "L5-L9" }] }],
    features: [{ id: "DOM-BBB-01-01", rd_ids: ["@x"] }],
    edges: [{ from: "BF-01.S1.P1", to: "DOM-BBB-01", kind: "TYPED_REL", type: "USES_DATA_FROM" }],
  } }, today: TODAY });
  const shown = kiln(root, ["dna", "footprint", "DOM-AAA-01-01"]);
  assert.equal(shown.status, 0, shown.stderr);
  const [entry] = Object.values(JSON.parse(shown.stdout));
  assert.deepEqual(entry.neighbors.SHARES_FILE.map(({ id, tier }) => [id, tier]), [["DOM-BBB-01-01", "MEDIUM"]]);
  assert.deepEqual(entry.neighbors.REL_CAPABILITY, [{ capability: "DOM-BBB-01", types: ["USES_DATA_FROM"] }]);
  assert.equal(entry.processes[0], "BF-01.S1.P1");
  assert.match(kiln(root, ["dna", "footprint", "DOM-ZZZ-01-01"]).stderr, /unknown feature id/);
});

// ------------------------------------------------------------------ panel reconciliation (D166)

test("kiln dna reconcile: consensus clusters, an escalation where a panel split a group, and a process every panel dropped", () => {
  const root = project();
  const dir = join(root, ".kiln", "tmp", "panels");
  const manifest = (panel, flows) => ({ panel, flows: flows.map(([id, processes]) => ({ id, name: `${panel} ${id}`, verdict: "crosses", stages: [{ name: "S1", processes }] })) });
  writeFile(join(dir, "g.json"), JSON.stringify(manifest("G", [["BF-01", ["P001", "P002", "P003"]], ["BF-02", ["P004"]]])));
  writeFile(join(dir, "h.json"), JSON.stringify(manifest("H", [["BF-01", ["P001", "P002", "P003"]], ["BF-02", ["P004"]]])));
  writeFile(join(dir, "i.json"), JSON.stringify(manifest("I", [["BF-01", ["P001", "P002"]], ["BF-02", ["P003", "P004"]]])));
  writeFile(join(dir, "roster.md"), "| id | name |\n|---|---|\n| P001 | a |\n| P002 | b |\n| P003 | c |\n| P004 | d |\n| P005 | e |\n");
  const run = kiln(root, ["dna", "reconcile", join(dir, "g.json"), join(dir, "h.json"), join(dir, "i.json"), "--roster", join(dir, "roster.md"), "--out", ".kiln/tmp/panels/result.json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Reconciled 5 processes across panels \["G","H","I"\] \(auto-accept threshold: 2\/3/);
  assert.match(run.stdout, /P005 missing from every panel/);
  const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.deepEqual(result.clusters.map((cluster) => cluster.processes), [["P001", "P002", "P003"], ["P004"], ["P005"]]);
  assert.deepEqual(result.escalations.map((entry) => entry.id), ["C01"], "panel I put P003 elsewhere, so the group is escalated, not voted");
  assert.deepEqual(parseRoster('{"P010": {}, "P002": {}}'), ["P010", "P002"]);
});

// ------------------------------------------------------------------ upstream check (D167)

test("the vendored methodology pages carry kiln's note in exactly the place the upstream check strips it", () => {
  for (const page of ["glossary", "id-schemes", "quality-gates", "agent-orchestration", "bootstrap-playbook", "update-playbook", "dna-store", "dna-erd", "bpm-alignment"]) {
    const lines = readFileSync(new URL(`../skills/kiln-dna/${page}.md`, import.meta.url), "utf8").split("\n");
    assert.match(lines[0], /^# /, page);
    assert.equal(lines[1], "", page);
    assert.match(lines[2], /^> \*\*In kiln:\*\* this page is tps-project-dna v2\.18\.1's text, verbatim\./, page);
    assert.match(lines[4], /^> the two disagree, kiln's commands win\.$/, page);
  }
});

// ------------------------------------------------------------------ D161–D168 review round (D169)

test("DNA checkpoint: two projects in one repository, and two worktrees, never restore each other's store", () => {
  const top = initRepo(tempRoot("kiln-mono-"));
  for (const name of ["a", "b"]) {
    writeFile(join(top, name, "package.json"), "{}");
    writeConfig(join(top, name), DEFAULTS);
  }
  commitAll(top, "two projects");
  applyBatch(join(top, "a"), { batch: { upsert: { domains: [{ id: "DOM-AAA", name: "A" }] } }, today: TODAY });
  applyBatch(join(top, "b"), { batch: { upsert: { domains: [{ id: "DOM-BBB", name: "B" }] } }, today: TODAY });
  rmSync(join(top, "a", ".kiln", "dna"), { recursive: true });
  assert.match(kiln(join(top, "a"), ["dna", "restore"]).stdout, /Store restored/);
  assert.deepEqual(readStore(join(top, "a")).data.domains.map((row) => row.id), ["DOM-AAA"], "a gets a's store back");
  assert.deepEqual(readStore(join(top, "b")).data.domains.map((row) => row.id), ["DOM-BBB"], "and b's is untouched");

  const other = join(tempRoot("kiln-wt-"), "wt");
  git(top, ["worktree", "add", "-q", "-b", "side", other]);
  assert.match(kiln(join(other, "a"), ["dna"]).stdout, /No DNA store in this project yet/, "a fresh worktree is not offered the main worktree's store");
});

test("DNA checkpoint: a rejecting reference-transaction hook and a failing clean filter neither run nor stop it, and a failure is said", () => {
  const root = project();
  const hooks = join(root, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "reference-transaction"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git(root, ["config", "filter.broken.clean", "false"]);
  writeFile(join(root, ".gitattributes"), "*.jsonl filter=broken\n");
  const plan = applyBatch(root, { batch: seedBatch(), today: TODAY });
  assert.match(plan.checkpoint.commit ?? "", /^[0-9a-f]{40}$/, JSON.stringify(plan.checkpoint));
  const outside = tempRoot("kiln-nogit-");
  writeConfig(outside, DEFAULTS);
  const shown = kiln(outside, ["dna", "apply", join(outside, "b.json")]);
  assert.match(shown.stderr, /could not be read as a batch/);
  writeFile(join(outside, "b.json"), JSON.stringify({ upsert: { domains: [{ id: "DOM-AAA", name: "A" }] } }));
  assert.match(kiln(outside, ["dna", "apply", join(outside, "b.json")]).stdout, /No checkpoint was taken \(.+\)/);
});

test("DNA remap: a delete is judged on the store as it was, and refused while anything still names the deleted capability", () => {
  const root = remapFixture();
  applyBatch(root, { batch: { upsert: { capabilities: [{ domain_id: "DOM-AAA", name: "Empty" }] } }, today: TODAY });
  assert.throws(() => remapPlan(root, { plan: { feature_moves: [{ feature: "DOM-AAA-01-01", target_capability: "DOM-BBB-01" }], deletes: [{ capability: "DOM-AAA-01" }] }, apply: true }), /not empty/, "emptying and deleting in one plan is refused, as by the source");
  applyBatch(root, { batch: { upsert: { excluded: [{ catalog: "UX", name: "Generic", capability_id: "DOM-AAA-03" }] } }, today: TODAY });
  assert.throws(() => remapPlan(root, { plan: { deletes: [{ capability: "DOM-AAA-03" }] }, apply: true }), /still referenced — move or remove these first: excluded:EXC-001/);
});

test("DNA remap: a round's update record is history and is not rewritten; process fields keep legacy_ copies; a stageless process is named", () => {
  const root = remapFixture();
  applyBatch(root, { batch: { upsert: { updates: [{ kind: "RESTRUCTURE", title: "first", renamed: [["DOM-AAA-01", "DOM-BBB-02"]] }] } }, today: TODAY });
  remapPlan(root, { plan: { capability_moves: [{ capability: "DOM-AAA-01", target_domain: "DOM-BBB" }] }, apply: true });
  const { data } = readStore(root);
  assert.deepEqual(data.updates[0].ext.renamed, [["DOM-AAA-01", "DOM-BBB-02"]]);
  assert.equal(data.processes.find((row) => row.name === "Do one").legacy_primary_capability_id, "DOM-AAA-01");
  applyBatch(root, { batch: { upsert: { processes: [{ id: "BF-01.S9.P1", flow_id: "BF-01", name: "Floating" }] } }, today: TODAY });
  assert.throws(() => remapPlan(root, { plan: { renumber_flows: true }, apply: false }), /every process needs a stage .* BF-01\.S9\.P1/);
  assert.match(kiln(root, ["dna", "remap"]).stderr, /kiln dna remap needs a plan file/);
});

test("the review round's smaller ones: --min-agree, an empty or repeated roster, --limit in the size, text metrics", () => {
  const root = project();
  const dir = join(root, ".kiln", "tmp", "panels");
  const manifest = (panel) => ({ panel, flows: [{ id: "BF-01", name: "J", verdict: "crosses", stages: [{ name: "S1", processes: ["P001", "P002"] }] }] });
  writeFile(join(dir, "g.json"), JSON.stringify(manifest("G")));
  writeFile(join(dir, "h.json"), JSON.stringify(manifest("H")));
  writeFile(join(dir, "roster.txt"), "P-1\nP-2\n");
  const args = ["dna", "reconcile", join(dir, "g.json"), join(dir, "h.json")];
  assert.match(kiln(root, [...args, "--min-agree", "x"]).stderr, /--min-agree takes a whole number/);
  assert.match(kiln(root, [...args, "--min-agree", "0"]).stdout, /auto-accept threshold: 2\/2/, "0 is the majority, as in the source");
  assert.match(kiln(root, [...args, "--roster", join(dir, "roster.txt")]).stdout, /no --roster given/, "a roster that parsed to nothing is no roster, and is said");
  const repeated = reconcilePanels([readManifest(manifest("G"), "G")], { minAgree: 1, roster: ["P003", "P003"] });
  assert.deepEqual(repeated.missing_from_every_panel, ["P003"]);
  assert.equal(recordedPace({ updates: [{ ext: { metrics: { lines_scanned: "500", minutes: "5" } } }] }), null, "a metric that is not a number is not a measurement");
  const { root: scanned } = scanFixture({ "src/a.js": BRANCHY, "src/b.js": BRANCHY });
  assert.match(kiln(scanned, ["dna", "scan", "--limit", "1"]).stdout, /this run takes 1 of them \(--limit 1\): to read: 1 file/);
});
