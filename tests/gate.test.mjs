import { test } from "node:test";
import assert from "node:assert/strict";
import { DECISION, classifyAnswer, reAskFor } from "../lib/gate.mjs";

test("D21: a strong affirmative approves", () => {
  for (const answer of ["yes", "Yes, go ahead", "approved", "LGTM", "ship it", "proceed"]) {
    assert.equal(classifyAnswer(answer), DECISION.approved, answer);
  }
});

test("D21: the named non-yeses are refused, every one of them", () => {
  for (const answer of ["whatever you think", "sounds good", "sure let's go", "up to you", "you decide", "ok"]) {
    assert.equal(classifyAnswer(answer), DECISION.notAYes, answer);
  }
});

test("silence is not consent", () => {
  assert.equal(classifyAnswer(""), DECISION.notAYes);
  assert.equal(classifyAnswer("   "), DECISION.notAYes);
  assert.equal(classifyAnswer(undefined), DECISION.notAYes);
});

test("a rejection is read as a rejection, not as the verb buried inside it", () => {
  assert.equal(classifyAnswer("no, don't proceed"), DECISION.rejected, "`proceed` must not win here");
  assert.equal(classifyAnswer("stop"), DECISION.rejected);
  assert.equal(classifyAnswer("not yet"), DECISION.rejected);
});

/**
 * Every test above this line feeds one clean clause, which is how a whole-text scan
 * survived: it read "yes, approved — no new flag" as a REJECTION, because `no` sat in a
 * condition attached to the approval. Real answers carry conditions.
 */
test("an approval with conditions attached is still an approval", () => {
  for (const answer of [
    "yes, approved — cap stays 20, no new flag",
    "approved, no changes needed",
    "yes, go ahead — but no extra dependencies",
    "lgtm, nothing to stop for",
    "I have read it and I approve",
  ]) {
    assert.equal(classifyAnswer(answer), DECISION.approved, answer);
  }
});

test("a rejection with a reason attached is still a rejection", () => {
  assert.equal(classifyAnswer("no, do not proceed"), DECISION.rejected);
  assert.equal(classifyAnswer("not yet, the plan misses the empty case"), DECISION.rejected);
});

test("a verdict that is not in the opening clause is not a verdict", () => {
  assert.equal(classifyAnswer("sounds good, no changes"), DECISION.notAYes, "soft agreement stays soft");
  assert.equal(classifyAnswer("after thinking about it for a while, yes"), DECISION.notAYes, "a gate wants a clear answer");
});

test("an answer nothing recognises defaults to deny", () => {
  assert.equal(classifyAnswer("the weather is nice"), DECISION.notAYes);
});

test("a delegation is turned back into two concrete options", () => {
  const again = reAskFor("plan");
  assert.equal(again.gate, "plan");
  assert.match(again.ask, /\(1\).*\(2\)/s, "two options, not a re-worded question");
});
