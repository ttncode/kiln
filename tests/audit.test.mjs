import { test } from "node:test";
import assert from "node:assert/strict";
import { writesSince } from "../scripts/post-run-audit.mjs";

/**
 * Measured on this release's own acceptance runs: every repository whose first commit was
 * made locally failed "no write to main" on the commit that created main — before any work
 * opened. The gate counts what the run did, so the log is read back to the work's base.
 */
test("the audit counts writes to the integration branch since the work opened, not before", () => {
  const base = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
  assert.deepEqual(writesSince(`${base} commit (initial): first`, base), [], "creating the branch is not the run's write");
  const moved = writesSince(`bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222 commit: agent wrote here\n${base} commit (initial): first`, base);
  assert.equal(moved.length, 1);
  assert.equal(writesSince("cccc commit: x", null).length, 1, "with no base known, every write counts");
});
