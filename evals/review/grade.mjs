/**
 * A fresh reader decides, per planted defect, whether any report of one review found it. The
 * bar is the defect itself — the same code and the same failure — so a generic caution or a
 * different problem at the same line does not count.
 */

function reportsText(reports) {
  return reports.map((report) => `### Reader ${report.id}\n\n${report.text || `(no report: ${report.error})`}`).join("\n\n");
}

export function gradePrompt(defects, reports) {
  const listed = defects.map((defect) => `- ${defect.id}: at ${defect.where} — ${defect.what}`).join("\n");
  return `You grade code-review reports against defects that were planted in a change.

Planted defects:
${listed}

For each defect, decide whether any report below identifies it. It counts only when a report points at the same code (file, function or route) and describes the same failure or consequence. A generic remark ("check security", "consider error handling", "add tests") does not count, and neither does a finding at the same code about a different problem.

Answer with one JSON object and nothing else:
{"<defect id>": {"caught": true or false, "reader": "<reader id>" or null, "evidence": "<a short quote from that report, or empty>"}}

Reports:

${reportsText(reports)}`;
}

function parsedObject(text) {
  const match = /\{[\s\S]*\}/.exec(text ?? "");
  try {
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

/** A grade that cannot be read is `caught: null` — unknown, never counted as a miss. */
export function parseGrade(text, defects) {
  const parsed = parsedObject(text);
  const verdict = (entry) => (typeof entry?.caught === "boolean" ? entry.caught : null);
  return Object.fromEntries(defects.map((defect) => [defect.id, { caught: verdict(parsed?.[defect.id]), reader: parsed?.[defect.id]?.reader ?? null, evidence: parsed?.[defect.id]?.evidence ?? "" }]));
}
