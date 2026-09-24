import { DnaError } from "./store.mjs";

/**
 * D175: the store is committed, and a quote is copied code, so a credential in the code can ride
 * into history. These are gitleaks' prefix-anchored rules (config/gitleaks.toml, MIT — NOTICE),
 * the kind GitHub push protection limits itself to because they rarely misfire. Its generic and
 * entropy-only rules are left out for the opposite reason, and so is a secret with no prefix,
 * such as an AWS secret access key; the scanner prompt forbids quoting any credential value.
 */
const RULES = [
  ["aws-access-token", /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g, /.+EXAMPLE$/],
  ["private-key", /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/i],
  ["github-pat", /ghp_[0-9a-zA-Z]{36}/],
  ["github-fine-grained-pat", /github_pat_\w{82}/],
  ["github-oauth", /gho_[0-9a-zA-Z]{36}/],
  ["slack-bot-token", /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/],
  ["slack-user-token", /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/],
  ["slack-webhook-url", /(?:https?:\/\/)?hooks.slack.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/],
  ["stripe-access-token", /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}(?=[\x60'"\s;]|\\[nr]|$)/],
  ["gcp-api-key", /\bAIza[\w-]{35}(?=[\x60'"\s;]|\\[nr]|$)/],
];

/** Every string in a record, as written: JSON's escaping would put `\n` before a key and `\"` after it, and defeat the rules' anchors. */
function strings(value) {
  const found = [];
  JSON.stringify(value, (key, each) => {
    if (typeof key === "string" && key !== "") found.push(key);
    if (typeof each === "string") found.push(each);
    return each;
  });
  return found;
}

/** gitleaks' rule allowlists judge the matched secret: AWS's own documentation keys end in EXAMPLE. */
function matches(text, [, pattern, allowed]) {
  if (!allowed) return pattern.test(text);
  return [...text.matchAll(pattern)].some((match) => !allowed.test(match[0]));
}

function leaks(record) {
  const texts = strings(record);
  return RULES.filter((rule) => texts.some((text) => matches(text, rule))).map(([id]) => id);
}

/** Refuses the batch, naming the record and the rule but never echoing the value. */
export function refuseSecrets(batch) {
  const records = [...Object.values(batch.upsert ?? {}).flat(), ...(batch.settings ? [{ key: "settings", ...batch.settings }] : [])];
  const found = records
    .map((record) => ({ record: record.id ?? record.key ?? "a new record", rules: leaks(record) }))
    .filter((each) => each.rules.length > 0);
  if (found.length === 0) return;
  const lines = found.map((each) => `  ${each.record}: ${each.rules.join(", ")}`).join("\n");
  throw new DnaError(`${found.length} record(s) carry what looks like a credential; nothing was written. Cite the lines and quote around the value, never the value itself:\n${lines}`);
}
