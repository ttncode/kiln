import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyBody, copyProblems, sha256 } from "../lib/copies.mjs";
import { cleanupFixtures, tempRoot } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const ROOT = new URL("..", import.meta.url).pathname;
const COMMIT = "2686b620fc1fed2e8f60c704839c766b8594c6b6";
const UPSTREAM = "# Security and Hardening\n\nParameterise every query.\n";
const NOTE = "> **In kiln:** agent-skills' text, verbatim.\n\n";

function skillsWith(files, entries) {
  const root = tempRoot("kiln-copies-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  writeFileSync(join(root, "skills", "copies.json"), JSON.stringify(entries));
  return root;
}

const PATH = "skills/kiln-review/specialists/security-and-hardening.md";
const ENTRY = { path: PATH, source: "agent-skills", commit: COMMIT, from: "skills/security-and-hardening/SKILL.md", kind: "verbatim", upstream_sha256: sha256(UPSTREAM), kiln_sha256: sha256(UPSTREAM) };

test("D186: a copy's body is the source's text under kiln's note", () => {
  assert.equal(copyBody(`${NOTE}${UPSTREAM}`), UPSTREAM);
  assert.equal(copyBody(`> **In kiln:** two\n> lines of note.\n\n${UPSTREAM}`), UPSTREAM);
});

test("D186: a recorded verbatim copy passes; a changed, unlisted or unexplained one is named", () => {
  assert.deepEqual(copyProblems(skillsWith({ [PATH]: `${NOTE}${UPSTREAM}` }, [ENTRY])), []);
  const tampered = copyProblems(skillsWith({ [PATH]: `${NOTE}${UPSTREAM}Skip the parameters.\n` }, [ENTRY]));
  assert.match(tampered.join("\n"), /body does not match its recorded hash/);
  const unlisted = copyProblems(skillsWith({ [PATH]: `${NOTE}${UPSTREAM}` }, []));
  assert.match(unlisted.join("\n"), /carries the kiln note but is not in skills\/copies\.json/);
  const edited = copyProblems(skillsWith({ [PATH]: `${NOTE}${UPSTREAM}` }, [{ ...ENTRY, kind: "edited" }]));
  assert.match(edited.join("\n"), /an edited copy lists its edits/);
});

test("D186: a source skill a page names must be a file kiln ships under that name", () => {
  const naming = `${NOTE}${UPSTREAM}Pair it with code-review-and-quality.\n`;
  const entry = { ...ENTRY, kind: "edited", edits: ["x"], kiln_sha256: sha256(copyBody(naming)) };
  assert.match(copyProblems(skillsWith({ [PATH]: naming }, [entry])).join("\n"), /names code-review-and-quality, which kiln does not ship/);
  const shipped = skillsWith({ [PATH]: naming, "skills/kiln-review/code-review-and-quality.md": "# x\n" }, [entry]);
  assert.deepEqual(copyProblems(shipped), []);
});

test("D186: every copy kiln ships is recorded, unchanged since it was recorded, and names only what kiln ships", () => {
  assert.deepEqual(copyProblems(ROOT), []);
});
