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

/**
 * A menu prints numbered options, and a person answering one may send the label back with
 * the marker attached. The marker is the menu's, not theirs — but a bare number is still a
 * click, which is the part D21 is about.
 */
test("a menu label is read as the answer; the number alone is not", () => {
  assert.equal(classifyAnswer("1. Approve this plan as written"), DECISION.approved);
  assert.equal(classifyAnswer("2) Approve it"), DECISION.approved);
  assert.equal(classifyAnswer("- approve"), DECISION.approved);
  assert.equal(classifyAnswer("3. Stop here, keep the artifacts"), DECISION.rejected);

  assert.equal(classifyAnswer("1"), DECISION.notAYes, "a click is not evidence anyone read it");
  assert.equal(classifyAnswer("1."), DECISION.notAYes);
  assert.equal(classifyAnswer("2"), DECISION.notAYes);
});

/**
 * The menu label grew a `(recommended)` suffix. A format change that quietly stopped a gate
 * recording approvals would be the most expensive kind, so the label is classified here
 * rather than assumed — and a bare number still has to say nothing.
 */
test("the recommended label still records an approval, and a bare number still does not", () => {
  assert.equal(classifyAnswer("1. Approve this plan as written (recommended)"), DECISION.approved);
  assert.equal(classifyAnswer("Approve this plan as written (recommended)"), DECISION.approved);
  assert.equal(classifyAnswer("1"), DECISION.notAYes, "a click is not a reading");
  assert.equal(classifyAnswer("3. Stop here, keep the artifacts"), DECISION.rejected);
});

/**
 * Measured while reproducing a real session's review gate. The verdict word was matched
 * before any negation around it, so a refusal that *contains* the verb was recorded as an
 * approval — and an approval authorises source edits. D21's gate exists to refuse soft
 * yeses; these are hard noes, and they were opening it.
 */
test("a refusal that contains the verb is a refusal, never an approval", () => {
  for (const answer of ["I don't approve this", "Not approved", "I cannot approve this yet", "don't ship it", "No. I won't approve it", "never approve that"]) {
    assert.notEqual(classifyAnswer(answer), DECISION.approved, answer);
  }
});

/**
 * The orchestrator renders "1. Accept this review and ship the change" at a review gate,
 * and the user answering `1` was then told it was not a yes. A verb that refuses a
 * reasonable answer teaches the agent to reword the user (D112).
 */
test("accepting is an explicit yes, with the same negation rule", () => {
  assert.equal(classifyAnswer("1. Accept this review and ship the change (recommended)"), DECISION.approved);
  assert.equal(classifyAnswer("accepted"), DECISION.approved);
  assert.notEqual(classifyAnswer("I can't accept this"), DECISION.approved);
});

test("a word that merely ends in -nt is not a negation", () => {
  for (const answer of ["Approve the current plan", "yes, what I want", "approved as different from before"]) {
    assert.equal(classifyAnswer(answer), DECISION.approved, answer);
  }
});
