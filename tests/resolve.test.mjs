import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  RESERVED,
  ResolveError,
  isUrl,
  looksLikeTicketRef,
  mintId,
  modulePrefixFor,
  resolveArgument,
  resumeAction,
  slugify,
} from "../lib/resolve.mjs";
import { STATUS, newWork, statePath, writeState } from "../lib/state.mjs";
import { listWork } from "../lib/work.mjs";
import { cleanupFixtures, tempRoot } from "./helpers/fixture.mjs";

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
  assert.deepEqual(RESERVED, ["init", "doctor", "dna"]);
  for (const word of RESERVED) {
    assert.equal(resolveArgument({ arg: word, root: tempRoot() }).kind, "reserved");
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

test("B53 / D24: a shipped work opens the next pass only after confirmation", () => {
  const root = tempRoot();
  writeState(root, { ...newWork({ id: "42", sessionId: "s", base: "aaa" }), status: STATUS.shipped });

  const resolved = resolveArgument({ arg: "42", root });
  assert.equal(resolved.action, "next_pass");
  assert.equal(resolved.confirm, true);
  assert.equal(resolved.pass, 2);
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
