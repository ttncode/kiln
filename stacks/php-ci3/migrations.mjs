/**
 * Detection of a *dangerous* effect is deliberately not in the stack's JSON: it must
 * fire without the agent's cooperation, so it is a script, and config never carries a
 * safety regex (D30).
 */
const DESTRUCTIVE = [
  { pattern: /\bDROP\s+TABLE\b/i, what: "DROP TABLE" },
  { pattern: /\bDROP\s+COLUMN\b/i, what: "DROP COLUMN" },
  { pattern: /\bTRUNCATE\b/i, what: "TRUNCATE" },
  { pattern: /\bDROP\s+DATABASE\b/i, what: "DROP DATABASE" },
  { pattern: /\bdrop_column\s*\(/i, what: "drop_column()" },
  { pattern: /\bdrop_table\s*\(/i, what: "drop_table()" },
];

/** A DELETE with no WHERE empties the table, which is the same loss by another verb. */
const UNBOUNDED_DELETE = /\bDELETE\s+FROM\s+\S+\s*(?:;|$)/i;

const MIGRATION_PATH = /(^|\/)migrations?\//i;

function contentOf(toolInput) {
  return toolInput?.content ?? toolInput?.new_string ?? "";
}

function findingIn(text) {
  const hit = DESTRUCTIVE.find((rule) => rule.pattern.test(text));
  if (hit) return hit.what;
  return UNBOUNDED_DELETE.test(text) ? "DELETE with no WHERE" : null;
}

export function check(payload) {
  const path = payload.tool_input?.file_path;
  if (!path || !MIGRATION_PATH.test(path)) return null;

  const found = findingIn(contentOf(payload.tool_input));
  if (!found) return null;
  return {
    blocked: true,
    reason: `${found} in ${path} destroys data that no migration can bring back.
If it is genuinely intended, say so at the gate and write it yourself — kiln will not.`,
  };
}
