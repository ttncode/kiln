import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  RESERVED,
  ResolveError,
  isUrl,
  modifiersOf,
  looksLikeTicketRef,
  mintId,
  modulePrefixFor,
  resolveArgument,
  resumeAction,
  slugify,
} from "../lib/resolve.mjs";
import { STATUS, newWork, statePath, writeState } from "../lib/state.mjs";
import { listWork } from "../lib/work.mjs";
import { spawnSync } from "node:child_process";
import { DEFAULTS } from "../lib/config.mjs";
import { readState } from "../lib/state.mjs";
import { cleanupFixtures, tempRoot, writeConfig } from "./helpers/fixture.mjs";

const writeConfigFor = (root) => writeConfig(root, DEFAULTS);

after(cleanupFixtures);

const AT = new Date("2026-09-20T08:00:00Z");
const githubTracker = { tracker: { provider: "github" } };

test("B07: a sentence becomes the date and a slug", () => {
  const id = mintId({ text: "the export button on the reports page does nothing", now: AT });
  assert.equal(id, "20260920-export-button-reports-page-nothing");
});

test("filler words are dropped, but never at the cost of a too-short slug", () => {
  assert.equal(slugify("it is on the a"), "it-is-on-the-a", "stripping filler would leave nothing");
  assert.equal(slugify("fix the flaky upload retry timer"), "fix-flaky-upload-retry-timer");
});

test("D51: a tracker ref is used exactly as the tracker writes it", () => {
  assert.equal(mintId({ text: "PROJ-123", now: AT }), "PROJ-123");
  assert.equal(mintId({ text: "42", now: AT }), "42");
});

test("a ref is told apart from a sentence", () => {
  assert.equal(looksLikeTicketRef("42"), true);
  assert.equal(looksLikeTicketRef("PROJ-123"), true);
  assert.equal(looksLikeTicketRef("proj-123"), false, "lowercase is a slug, not a ref");
  assert.equal(looksLikeTicketRef("the export button"), false);
});

test("D51: the module prefix appears only when two modules could own the same issue", () => {
  const single = { repo: { kind: "single" } };
  const oneOwner = { repo: { kind: "multi", tickets: ["admin-page"] } };
  const twoOwners = { repo: { kind: "multi", tickets: ["admin-page", "portal"] } };

  assert.equal(modulePrefixFor(single), null);
  assert.equal(modulePrefixFor(oneOwner), null, "one owner cannot collide with anything");
  assert.equal(modulePrefixFor(twoOwners), "admin-page");
});

test("B10: a URL is recognised before anything else tries to interpret it", () => {
  assert.equal(isUrl("https://github.com/you/app/issues/42"), true);
  const resolved = resolveArgument({ arg: "https://github.com/you/app/issues/42", root: tempRoot() });
  assert.equal(resolved.kind, "url");
  assert.equal(resolved.action, "fetch");
});

test("B12 / D79: a reserved word resolves ahead of every other branch", () => {
  assert.deepEqual(RESERVED, ["init", "doctor", "rules", "dna"],
    "`rules` joined once a user typed it: a word a user types is reserved, or work/<word>/ shadows the command");
  for (const word of RESERVED) {
    assert.equal(resolveArgument({ arg: word, root: tempRoot() }).kind, "reserved");
  }
});

/**
 * B12 asks for more than the classification: `/kiln dna` at tier 0 must *report that DNA is
 * v1.2*. Without the message the orchestrator read `reserved` as "run that command" and ran
 * `kiln dna`, which does not exist — a usage error in place of the answer.
 */
test("B12: a word held for a later version says so, and names what exists instead", () => {
  const { message } = resolveArgument({ arg: "dna", root: tempRoot() });
  assert.match(message, /v1\.2/, "it names the version the user is waiting for");
  assert.match(message, /kiln blast/, "and the tier-0 command that works today");

  for (const word of ["init", "doctor"]) {
    assert.equal(resolveArgument({ arg: word, root: tempRoot() }).message, null, `${word} is a command, not a reservation`);
  }
});

test("B14: a work directory cannot shadow a reserved word", () => {
  const root = tempRoot();
  writeState(root, newWork({ id: "dna", sessionId: "s", base: "aaa" }));
  assert.equal(resolveArgument({ arg: "dna", root }).kind, "reserved", "the command wins");
});

test("B11: a bare argument lists work in progress", () => {
  assert.equal(resolveArgument({ arg: undefined, root: tempRoot() }).kind, "list");
});

test("B09: an existing work directory wins over reading the argument as a ticket ref", () => {
  const root = tempRoot();
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));

  const resolved = resolveArgument({ arg: "42", root, config: githubTracker });
  assert.equal(resolved.kind, "work");
  assert.equal(resolved.action, "resume");
});

test("B08: a ref with a tracker configured is fetched", () => {
  const resolved = resolveArgument({ arg: "PROJ-7", root: tempRoot(), config: githubTracker });
  assert.equal(resolved.kind, "ticket");
  assert.equal(resolved.id, "PROJ-7");
});

test("a ref with no tracker is treated as the description it plainly is", () => {
  const resolved = resolveArgument({ arg: "42", root: tempRoot(), config: { tracker: { provider: "none" } } });
  assert.equal(resolved.kind, "description");
});

test("B13: an unreadable state refuses rather than reusing the directory", () => {
  const root = tempRoot();
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));
  writeFileSync(statePath(root, "42"), "{ not json", "utf8");

  assert.throws(() => resolveArgument({ arg: "42", root }), (err) => {
    assert.ok(err instanceof ResolveError);
    assert.match(err.message, /will not reuse/);
    return true;
  });
});

test("B13: a directory recording another work's id is refused, naming both", () => {
  const root = tempRoot();
  const state = newWork({ id: "PROJ-9", sessionId: "s", base: "aaa" });
  writeState(root, { ...state, id: "42" });
  writeFileSync(statePath(root, "42"), JSON.stringify({ ...state, id: "PROJ-9" }), "utf8");

  assert.throws(() => resolveArgument({ arg: "42", root }), /records work "PROJ-9"/);
});

test("D24: resume branches on status rather than assuming in_progress", () => {
  const base = newWork({ id: "42", sessionId: "s", base: "aaa" });
  assert.equal(resumeAction(base).action, "resume");
  assert.equal(resumeAction({ ...base, status: STATUS.reviewed }).action, "ship");
  assert.equal(resumeAction({ ...base, status: STATUS.halted }).action, "present_halt");
});

test("B52: a halted work re-presents its halt, never continues past it", () => {
  const root = tempRoot();
  writeState(root, { ...newWork({ id: "42", sessionId: "s", base: "aaa" }), status: STATUS.halted, stage: "PLAN" });

  const resolved = resolveArgument({ arg: "42", root });
  assert.equal(resolved.action, "present_halt");
  assert.equal(resolved.stage, "PLAN");
});

test("a shipped work is followed, never reopened: the follow-up is a new work that names it", () => {
  const root = tempRoot();
  writeState(root, { ...newWork({ id: "42", sessionId: "s", base: "aaa" }), status: STATUS.shipped });

  const resolved = resolveArgument({ arg: "42", root });
  assert.equal(resolved.action, "follow_up");
  assert.equal(resolved.id, "42.2");
  assert.equal(resolved.follows, "42");

  writeState(root, { ...newWork({ id: "42.2", sessionId: "s", base: "bbb", follows: "42" }), status: STATUS.shipped });
  assert.equal(resolveArgument({ arg: "42.2", root }).id, "42.3", "counted from the root id, never 42.2.2");
});

test("D67d: a resume asks for a preflight rather than trusting the recorded step", () => {
  const root = tempRoot();
  writeState(root, { ...newWork({ id: "42", sessionId: "s", base: "aaa" }), stage: "IMPLEMENT", step: "unit" });

  const resolved = resolveArgument({ arg: "42", root });
  assert.equal(resolved.preflight, true);
  assert.equal(resolved.stage, "IMPLEMENT");
});

test("B11: listWork reports an unreadable state rather than hiding it", () => {
  const root = tempRoot();
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));
  writeState(root, { ...newWork({ id: "PROJ-7", sessionId: "s", base: "bbb" }), status: STATUS.halted });
  writeFileSync(statePath(root, "42"), "{ not json", "utf8");

  const rows = listWork(root);
  assert.deepEqual(rows.map((r) => r.id), ["42", "PROJ-7"]);
  assert.equal(rows[0].status, "unreadable", "the shape guards block on must be visible here");
  assert.equal(rows[1].status, "halted");
});

test("listWork on a project with no work yet is empty, not an error", () => {
  assert.deepEqual(listWork(tempRoot()), []);
});

test("a description that names an existing work says so, without claiming to be it", () => {
  const root = tempRoot();
  writeState(root, newWork({ id: "c3-spike", sessionId: "s", base: "aaa" }));

  const resolved = resolveArgument({ arg: "Work id c3-spike, open, path spike, probe approved", root });

  assert.equal(resolved.kind, "description", "D24's order stands: a sentence is a description");
  assert.notEqual(resolved.id, "c3-spike", "and it still mints its own id");
  assert.deepEqual(resolved.mentions, ["c3-spike"], "but a second work created by accident is visible");
});

test("a description that names nothing carries no hint", () => {
  const resolved = resolveArgument({ arg: "the export button does nothing", root: tempRoot() });
  assert.equal("mentions" in resolved, false);
});

test("D58: a halted work re-presents its halt, and something can now set it", () => {
  const root = tempRoot();
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  writeConfigFor(root);
  const run = spawnSync(process.execPath, [bin, "halt", "42", "--reason", "blocking unknown: which backend"], { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(readState(root, "42").status, STATUS.halted);
  assert.deepEqual(readState(root, "42").carry_over.map((r) => r.text), ["blocking unknown: which backend"]);
  assert.equal(resolveArgument({ arg: "42", root }).action, "present_halt");
});

test("a halt without a reason is refused — a stop nobody can act on", () => {
  const root = tempRoot();
  writeConfigFor(root);
  writeState(root, newWork({ id: "42", sessionId: "s", base: "aaa" }));

  const bin = new URL("../bin/kiln.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [bin, "halt", "42"], { cwd: root, encoding: "utf8" });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /Pass --reason/);
});

/**
 * `/kiln full This route returns a 500` minted
 * `20260921-full-route-http-localhost-2380-admin` — every id from then on carrying a word
 * that describes kiln's process rather than the work.
 */
test("a leading ceremony word is an instruction, not part of what is asked", () => {
  const now = new Date("2026-09-21T00:00:00Z");
  assert.equal(mintId({ text: "full This route returns a 500 error", now }), "20260921-route-returns-500-error");
  assert.equal(mintId({ text: "spike — can we use the new API?", now }), "20260921-can-we-use-new-api");
  assert.equal(mintId({ text: "This route returns a 500 error", now }), "20260921-route-returns-500-error");
});

test("a ceremony word inside the sentence is somebody's actual subject", () => {
  const now = new Date("2026-09-21T00:00:00Z");
  assert.match(mintId({ text: "the full export is empty", now }), /full/);
});

test("--auto is read as an instruction, not as part of the subject", () => {
  const now = new Date("2026-09-21T00:00:00Z");
  assert.equal(mintId({ text: "--auto Remove this filter", now }), "20260921-remove-this-filter");
  assert.equal(mintId({ text: "--auto full Rebuild the importer", now }), "20260921-rebuild-the-importer");

  assert.deepEqual(
    { auto: modifiersOf("--auto full x").auto, path: modifiersOf("--auto full x").path },
    { auto: true, path: "full" },
  );
  assert.equal(modifiersOf("the auto-save filter is broken").auto, false, "a hyphenated word is somebody's subject");
  assert.equal(modifiersOf("Remove the filter").path, null);
});

/**
 * "Remove this filter at this URL http://localhost:2380/admin/product_list/" minted
 * `20260922-remove-filter-url-http-localhost-2380`, and the route case was worse: four of
 * its six words were the URL. The branch was named after where the thing lives rather than
 * what is being done to it.
 */
test("a URL is an address, not a subject", () => {
  const now = new Date("2026-09-22T00:00:00Z");
  const id = (text) => mintId({ text, now });

  assert.equal(
    id("Remove this filter at this URL `http://localhost:2380/admin/product_list/`. Only code, not db."),
    "20260922-remove-filter-admin-product-list-only",
    "the path says which screen; the host and port say nothing",
  );
  assert.equal(id("See www.example.com/docs/setup for the failing step"), "20260922-see-docs-setup-failing-step");

  for (const noise of ["http", "https", "localhost", "2380", "www"]) {
    assert.doesNotMatch(id(`Fix the thing at http://localhost:2380/admin/x`), new RegExp(noise));
  }
});

test("a URL quoted mid-sentence does not carry the quote into the slug", () => {
  const now = new Date("2026-09-22T00:00:00Z");
  assert.equal(mintId({ text: "Broken at `http://host/admin/product_list/`.", now }), "20260922-broken-admin-product-list");
});

test("`url` names the form of an address; `page` names a screen and stays", () => {
  const now = new Date("2026-09-22T00:00:00Z");
  // Long enough that the filler pass leaves four words; a shorter sentence keeps every word
  // it has rather than becoming a one-word slug.
  assert.doesNotMatch(mintId({ text: "The CSV export is broken at this URL http://host/admin/reports", now }), /url/);
  assert.match(mintId({ text: "The export button on the reports page does nothing", now }), /reports-page/);
});

/**
 * Measured: `/kiln:kiln rules add controllers.md` minted the work id
 * `20260923-rules-add-controllers-md` and started investigating it. The user's most natural
 * attempt at a command, answered by silently doing something else.
 *
 * D79 set this law for `dna` and gave the reason — a word a user types is reserved, or
 * `work/<word>/` shadows the command. It was written as an exact match because `init` and
 * `doctor` take no arguments, and `rules` does.
 */
test("a reserved word is read from the first word, so a verb with arguments still resolves", () => {
  const resolved = resolveArgument({ arg: "rules add controllers.md --trigger '**/*.php'", root: tempRoot() });
  assert.equal(resolved.kind, "reserved");
  assert.equal(resolved.command, "rules");
  assert.equal(resolved.rest, "add controllers.md --trigger '**/*.php'");
});

test("a bare reserved word carries no arguments", () => {
  const resolved = resolveArgument({ arg: "doctor", root: tempRoot() });
  assert.equal(resolved.rest, "");
});

/**
 * The trade, asserted so it stays deliberate: a sentence opening with a reserved word is
 * refused rather than run. That is the cheaper error — a refusal is visible and one rephrase
 * away, while minting a junk work and investigating it is silent and expensive.
 */
test("a sentence that merely opens with a reserved word is caught here, not minted as work", () => {
  const resolved = resolveArgument({ arg: "rules for the export page are wrong", root: tempRoot() });
  assert.equal(resolved.kind, "reserved", "the visible error beats the silent one");

  for (const sentence of ["the export button does nothing", "initialise the cache on boot"]) {
    assert.equal(resolveArgument({ arg: sentence, root: tempRoot() }).kind, "description", sentence);
  }
});
