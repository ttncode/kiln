/**
 * The guard corpus: every case a command or an edit, the verdict D7 requires, and the
 * production entry point deciding it.
 *
 * The shape is dcg's and cc-safety-net's — must-deny, must-allow and bypass rows in one
 * table — with the labels written against kiln's own scope. Both of those tools allow
 * `git push origin main`; kiln must refuse it, so their verdicts could not be reused even
 * where their commands could. None of their cases are copied here.
 *
 * `ceiling` rows are commands kiln deliberately does not see — an interpreter running a
 * script file, a program kiln cannot read — asserted as allowed so that a change which
 * silently widens or narrows the ceiling shows up as a failing row rather than as news.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupFixtures, git, tempRoot, writeFile } from "./helpers/fixture.mjs";
import { SESSION, nodeProject, ok } from "./helpers/journey.mjs";
import { judge } from "./helpers/hook.mjs";

after(cleanupFixtures);

const ID = "w1";
const DENY = 2;
const ALLOW = 0;

function project({ open = true, approved = false } = {}) {
  const root = nodeProject({ name: "corpus" });
  git(root, ["checkout", "-q", "-b", "feature/work"]);
  const outside = tempRoot("kiln-outside-");
  writeFile(join(outside, "file.txt"), "x\n");
  symlinkSync(join(outside, "file.txt"), join(root, "src", "link.txt"));
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  if (open) {
    ok(root, ["open", ID, "--session", SESSION]);
    ok(root, ["open", "other", "--session", "another-session"]);
  }
  if (approved) {
    writeFile(join(root, ".kiln", "work", ID, "plan.md"), "# plan\n");
    ok(root, ["gate", ID, "plan", "--artifact", `.kiln/work/${ID}/plan.md`, "--answer", "Approve this plan as written", "--predicted", "src/app.js"]);
  }
  return { root, outside };
}

function fill(text, { root, outside }) {
  return text.replaceAll("{outside}", outside).replaceAll("{root}", root).replaceAll("{id}", ID).replaceAll("{home}", homedir());
}

async function verdictOf([kind, input], fixture) {
  const filled = fill(input, fixture);
  const tool_input = kind === "edit" ? { file_path: filled.startsWith("/") ? filled : join(fixture.root, filled) } : { command: filled };
  return judge(kind === "edit" ? "pre-edit" : "pre-bash", { session_id: SESSION, cwd: fixture.root, tool_input });
}

function table(name, rows, setup) {
  describe(name, () => {
    let fixture;
    before(() => {
      fixture = setup();
    });
    for (const row of rows) {
      const [kind, input, expected, why] = row;
      test(`${expected.padEnd(7)} ${kind} ${input.replaceAll("\n", "⏎")}`, async () => {
        const { status, stderr } = await verdictOf(row, fixture);
        assert.equal(status, expected === "deny" ? DENY : ALLOW, stderr || "(allowed)");
        if (expected === "deny" && why) assert.match(stderr, why);
        if (expected === "deny") assert.doesNotMatch(stderr, /bug in kiln/);
      });
    }
  });
}

const PROTECTED = /protected branch/;
const DISARM = /turns off verification/;
const CONTROL = /enforces the run|control files|kiln cannot read what an inline program does/;
const SANDBOX = /outside the project root|another work's directory|symlink/;
const GATE = /plan gate is not approved|gate is not approved/;

// ------------------------------------------------------------- D7 item 1

const BRANCHES = [
  ["bash", "git push origin main", "deny", PROTECTED],
  ["bash", "git push origin HEAD:main", "deny", PROTECTED],
  ["bash", "git push origin feature/work:main", "deny", PROTECTED],
  ["bash", "git push origin feature/work:refs/heads/main", "deny", PROTECTED],
  ["bash", "git push origin +main", "deny", PROTECTED],
  ["bash", "git push --force origin main", "deny", PROTECTED],
  ["bash", "git push --force-with-lease origin main", "deny", PROTECTED],
  ["bash", "git -C . push origin main", "deny", PROTECTED],
  ["bash", "git -c user.name=x push origin main", "deny", PROTECTED],
  ["bash", "cd {root} && git push origin main", "deny", PROTECTED],
  ["bash", "cat > notes.txt <<EOF\nhello\nEOF\ngit push origin main", "deny", PROTECTED],
  ["bash", "git checkout main && git commit -m x", "deny", PROTECTED],
  ["bash", "git switch main && git commit -m x", "deny", PROTECTED],
  ["bash", "git checkout -b main && git commit -m x", "deny", PROTECTED],
  ["bash", "git push origin feature/work", "allow"],
  ["bash", "git push -u origin HEAD", "allow"],
  ["bash", "git push", "allow"],
  ["bash", "git push origin HEAD:refs/heads/feature/work", "allow"],
  ["bash", "git commit -m x", "allow"],
  ["bash", "git merge main", "allow"],
  ["bash", "git rebase main", "allow"],
  ["bash", "git fetch origin && git pull", "allow"],
  ["bash", "git checkout main", "allow"],
  ["bash", "git status && git log --oneline && git diff", "allow"],
  ["bash", "git checkout -b fix/y && git commit -m y", "allow"],
  ["bash", "git commit -m \"$(cat <<'EOF'\nfix: the thing\n\ngit push origin main is what we avoid\nEOF\n)\"", "allow"],
  ["bash", "cat > .kiln/tmp/{id}/note.md <<'EOF'\ncd /elsewhere && git commit -m x\nEOF", "allow"],
  ["bash", "cd \"$SOMEWHERE\" && git commit -m x", "allow"],
];

const DISARMING = [
  ["bash", "git push --no-verify origin feature/work", "deny", DISARM],
  ["bash", "git push --no-verif origin feature/work", "deny", DISARM],
  ["bash", "git push --no-ve origin feature/work", "deny", DISARM],
  ["bash", "git commit -n -m x", "deny", DISARM],
  ["bash", "git commit -nm x", "deny", DISARM],
  ["bash", "git commit -anm x", "deny", DISARM],
  ["bash", "git commit -m x --no-verify", "deny", DISARM],
  ["bash", "git -c core.hooksPath=/dev/null push origin feature/work", "deny", DISARM],
  ["bash", "git config core.hooksPath /dev/null", "deny", DISARM],
  ["bash", "GIT_CONFIG_PARAMETERS=\"'core.hookspath'='/dev/null'\" git push origin feature/work", "deny", DISARM],
  ["bash", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push", "deny", DISARM],
  ["bash", "git --config-env=core.hooksPath=HOOKS push origin feature/work", "deny", DISARM],
  ["bash", "HUSKY=0 git push origin feature/work", "deny", DISARM],
  ["bash", "git push -n origin feature/work", "allow"],
  ["bash", "git commit -m \"fix -n handling\"", "allow"],
  ["bash", "git commit -m \"mention --no-verify in a message\"", "allow"],
  ["bash", "git commit -mn", "allow"],
  ["bash", "git commit --no-edit --amend", "allow"],
  ["bash", "git log --no-walk", "allow"],
];

// ------------------------------------------------------------- D7 item 2 and 5

const DESTROYING = [
  ["bash", "rm -rf {outside}", "deny", SANDBOX],
  ["bash", "rm -Rf {outside}", "deny", SANDBOX],
  ["bash", "rm -fr {outside}", "deny", SANDBOX],
  ["bash", "rm -r -f {outside}", "deny", SANDBOX],
  ["bash", "rm --recursive --force {outside}", "deny", SANDBOX],
  ["bash", "rm -r {outside}", "deny", SANDBOX],
  ["bash", "rm -rf -- {outside}", "deny", SANDBOX],
  ["bash", "rm -rf ~/kiln-corpus-not-there", "deny", SANDBOX],
  ["bash", "rm -rf $HOME/kiln-corpus-not-there", "deny", SANDBOX],
  ["bash", "rm -rf node_modules", "allow"],
  ["bash", "rm -rf ./build dist", "allow"],
  ["bash", "rm -rf .kiln/tmp/{id}/scratch", "allow"],
  ["bash", "rm notes.txt", "allow"],
];

const SANDBOXED = [
  ["edit", "{outside}/file.txt", "deny", SANDBOX],
  ["edit", "src/link.txt", "deny", SANDBOX],
  ["edit", ".kiln/work/other/plan.md", "deny", SANDBOX],
  ["bash", "echo x > {outside}/f", "deny", SANDBOX],
  ["bash", "cat a>{outside}/f", "deny", SANDBOX],
  ["bash", "node x.mjs 2> {outside}/err.log", "deny", SANDBOX],
  ["bash", "tee {outside}/f < a", "deny", SANDBOX],
  ["bash", "cp a {outside}/f", "deny", SANDBOX],
  ["bash", "mv a {outside}/f", "deny", SANDBOX],
  ["bash", "sed -i s/a/b/ {outside}/file.txt", "deny", SANDBOX],
  ["bash", "cat > {outside}/f <<EOF\nx\nEOF", "deny", SANDBOX],
  ["bash", "cat > .kiln/tmp/{id}/ok.txt <<EOF\nx\nEOF\necho y > {outside}/f", "deny", SANDBOX],
  ["bash", "echo x > .kiln/work/other/notes.md", "deny", SANDBOX],
  ["bash", "echo x > .kiln/tmp/{id}/scratch.txt", "allow"],
  ["bash", "mysql -e \"SELECT a FROM t HAVING COUNT(*) > 1\"", "allow"],
  ["bash", "awk '{ if ($1 > 2) print }' src/app.js", "allow"],
  ["bash", "echo \"a > b\"", "allow"],
  ["bash", "cat > .kiln/tmp/{id}/n.md <<'EOF'\n> a quoted line\nEOF", "allow"],
];

// ------------------------------------------------------------- D7 item 4

const BEFORE_THE_GATE = [
  ["edit", "src/app.js", "deny", GATE],
  ["edit", "src/new.js", "deny", GATE],
  ["bash", "echo x > src/app.js", "deny", GATE],
  ["bash", "printf x >> src/app.js", "deny", GATE],
  ["bash", "sed -i s/1/2/ src/app.js", "deny", GATE],
  ["bash", "cp src/app.js src/copy.js", "deny", GATE],
  ["bash", "tee src/app.js < /dev/null", "deny", GATE],
  ["bash", "cat > src/new.js <<EOF\nexport {};\nEOF", "deny", GATE],
  ["bash", "gh pr create --fill", "deny", /pull request/],
  ["bash", "glab mr create --fill", "deny", /pull request/],
  ["edit", ".kiln/work/{id}/brief.md", "allow"],
  ["edit", ".kiln/work/{id}/plan.md", "allow"],
  ["edit", ".kiln/tmp/{id}/.superpowers/brainstorm/s1/content/layout.html", "allow"],
  ["bash", "W=.kiln/work/{id} && cat > $W/brief.md <<'EOF'\n# brief\nEOF\ncat .kiln/rules/index.md", "allow"],
  ["bash", "W=\".kiln/work/{id}\"; printf x > \"$W/notes.md\"", "allow"],
  ["bash", "D=src && echo x > $D/app.js", "deny", GATE],
  ["bash", "export D=src; echo x > ${D}/app.js", "deny", GATE],
  ["bash", "echo x > .kiln/tmp/{id}/scratch.txt", "allow"],
  ["bash", "cat src/app.js && grep -rn a src", "allow"],
  ["bash", "npm test", "allow"],
  ["bash", "cat .kiln/work/{id}/plan.md 2>/dev/null && git status --short", "allow"],
  ["bash", "npm test > /dev/null 2>&1", "allow"],
  ["bash", "npm test 2>&1 | tail -5", "allow"],
  ["bash", "echo done >&2", "allow"],
  ["bash", "node x.mjs &> /dev/null", "allow"],
  ["bash", "python3 -c \"open('src/app.js','w').write('x')\"", "ceiling"],
  ["bash", "node scripts/rewrite.mjs src/app.js", "ceiling"],
];

const AFTER_THE_GATE = [
  ["edit", "src/app.js", "allow"],
  ["bash", "echo x > src/app.js", "allow"],
  ["bash", "gh pr create --fill", "deny", /review gate is not approved/],
];

// ------------------------------------------------------------- D7 item 7

const CONTROL_FILES = [
  ["edit", ".kiln/config.json", "deny", CONTROL],
  ["edit", ".kiln/work/{id}/state.json", "deny", CONTROL],
  ["edit", ".kiln/hooks/pre-push.mjs", "deny", CONTROL],
  ["edit", ".git/hooks/pre-push", "deny", CONTROL],
  ["edit", ".git/config", "deny", CONTROL],
  ["edit", ".kiln/rules/index.md", "deny", /judged by/],
  ["bash", "echo {} > .kiln/config.json", "deny", CONTROL],
  ["bash", "sed -i s/main/x/ .kiln/config.json", "deny", CONTROL],
  ["bash", "cp /dev/null .kiln/config.json", "deny", CONTROL],
  ["bash", "rm .kiln/config.json", "deny", CONTROL],
  ["bash", "rm -f .kiln/work/{id}/state.json", "deny", CONTROL],
  ["bash", "truncate -s 0 .kiln/config.json", "deny", CONTROL],
  ["bash", "mv .kiln/work/{id}/state.json .kiln/work/{id}/old.md", "deny", CONTROL],
  ["bash", "mv .kiln/config.json .kiln/tmp/{id}/c.json", "deny", CONTROL],
  ["bash", "mv .kiln/work/{id} {outside}/w", "deny", CONTROL],
  ["bash", "git mv .kiln/config.json .kiln/c.json", "deny", CONTROL],
  ["bash", "rm -r .kiln/work/{id}", "deny", CONTROL],
  ["bash", "rm -rf .kiln", "deny", CONTROL],
  ["bash", "chmod 000 .kiln/work/{id}", "deny", CONTROL],
  ["bash", "rm .git/hooks/pre-push", "deny", CONTROL],
  ["bash", "echo x >> .kiln/rules/extra.md", "deny", /judged by/],
  ["bash", "node -e \"require('fs').writeFileSync('.kiln/config.json','{}')\"", "deny", CONTROL],
  ["bash", "node -p \"require('fs').writeFileSync('.kiln/config.json','{}')\"", "deny", CONTROL],
  ["bash", "node --eval \"require('fs').writeFileSync('.kiln/config.json','{}')\"", "deny", CONTROL],
  ["bash", "python3 -c \"open('.kiln/work/w1/state.json','w')\"", "deny", CONTROL],
  ["bash", "python3 - <<'EOF'\nopen('.kiln/config.json','w').write('{}')\nEOF", "deny", CONTROL],
  ["bash", "echo \"open('.kiln/config.json','w')\" | python3", "deny", CONTROL],
  ["bash", "bash -c \"echo {} > .kiln/config.json\"", "deny", CONTROL],
  ["bash", "cat .kiln/config.json", "allow"],
  ["bash", "cat .kiln/rules/index.md .kiln/config.json; node --version", "allow"],
  ["bash", "F=.kiln/config.json && echo {} > $F", "deny", CONTROL],
  ["bash", "grep main .kiln/config.json", "allow"],
  ["bash", "jq . .kiln/work/{id}/state.json", "allow"],
  ["bash", "python3 -m json.tool .kiln/config.json", "allow"],
  ["bash", "node /opt/kiln/bin/kiln.mjs gate {id} plan --artifact .kiln/work/{id}/plan.md --answer yes", "allow"],
  ["bash", "rm src/link.txt", "allow"],
];

const NOTHING_OPEN = [
  ["edit", ".kiln/config.json", "deny", CONTROL],
  ["bash", "rm .kiln/config.json", "deny", CONTROL],
  ["bash", "mv .kiln/config.json /tmp/c.json", "deny", CONTROL],
  ["bash", "git push origin main", "deny", PROTECTED],
  ["bash", "git push --no-verify origin feature/work", "deny", DISARM],
  ["edit", "src/app.js", "allow"],
  ["edit", "{outside}/file.txt", "allow"],
  ["edit", ".kiln/rules/new.md", "allow"],
  ["bash", "rm -rf {outside}", "allow"],
  ["bash", "rm src/link.txt", "allow"],
];

table("D7 item 1: protected branches, standing on a feature branch", BRANCHES, () => project());
table("D7 item 1: the floor cannot be switched off", DISARMING, () => project());
table("D7 item 2: destroying data outside the project", DESTROYING, () => project());
table("D7 item 5: the sandbox", SANDBOXED, () => project());
table("D7 item 4: before the plan gate", BEFORE_THE_GATE, () => project());
table("D7 item 4: after the plan gate", AFTER_THE_GATE, () => project({ approved: true }));
table("D7 item 7: the files the run is judged by", CONTROL_FILES, () => project());
table("with no work open, only what does not depend on a run holds", NOTHING_OPEN, () => project({ open: false }));
