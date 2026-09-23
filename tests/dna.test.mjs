import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { canonical } from "../lib/dna/contract.mjs";
import { componentId, componentRoot, derive, serviceOfPath, stripDerived } from "../lib/dna/derive.mjs";
import { jargonHits, runGates } from "../lib/dna/gates.mjs";
import { idScheme, nextId } from "../lib/dna/ids.mjs";
import { applyBatch, checkStore } from "../lib/dna/apply.mjs";
import { readStore, storeDir } from "../lib/dna/store.mjs";
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
