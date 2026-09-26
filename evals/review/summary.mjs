/**
 * Per planted defect and arm: how many runs caught it, out of how many a grader could judge.
 * An unknown grade is shown, never folded into a miss.
 */

function cell(records, key) {
  const graded = records.map((record) => record.grades[key.defect]?.caught).filter((caught) => caught !== null && caught !== undefined);
  return { caught: graded.filter(Boolean).length, graded: graded.length, runs: records.length };
}

function defectRows(records, arms) {
  const keys = [...new Map(records.flatMap((record) => Object.keys(record.grades).map((defect) => [`${record.fixture} ${defect}`, { fixture: record.fixture, defect }]))).values()];
  return keys.map((key) => ({
    ...key,
    arms: Object.fromEntries(arms.map((arm) => [arm, cell(records.filter((record) => record.fixture === key.fixture && record.arm === arm), key)])),
  }));
}

function armTotals(rows, records) {
  const arms = [...new Set(records.map((record) => record.arm))];
  return Object.fromEntries(arms.map((arm) => {
    const cells = rows.map((row) => row.arms[arm]);
    const cost = records.filter((record) => record.arm === arm).reduce((sum, record) => sum + record.cost, 0);
    const failed = records.filter((record) => record.arm === arm).reduce((sum, record) => sum + record.failed.length, 0);
    return [arm, { caught: cells.reduce((sum, each) => sum + each.caught, 0), graded: cells.reduce((sum, each) => sum + each.graded, 0), cost: Number(cost.toFixed(2)), failedReaders: failed }];
  }));
}

export function summarize(records, meta) {
  const rows = defectRows(records, meta.arms);
  return { meta: { model: meta.model, reps: meta.reps, arms: meta.arms, pins: meta.pins, date: new Date().toISOString() }, rows, totals: armTotals(rows, records) };
}

export function renderSummary(summary) {
  const { arms } = summary.meta;
  const head = `| fixture | defect | ${arms.join(" | ")} |\n|---|---|${arms.map(() => "---").join("|")}|`;
  const body = summary.rows.map((row) => `| ${row.fixture} | ${row.defect} | ${arms.map((arm) => `${row.arms[arm].caught}/${row.arms[arm].graded}`).join(" | ")} |`).join("\n");
  const totals = arms.map((arm) => `- **${arm}**: ${summary.totals[arm].caught}/${summary.totals[arm].graded} caught, $${summary.totals[arm].cost}, ${summary.totals[arm].failedReaders} failed reader run(s)`).join("\n");
  return `Model ${summary.meta.model}, ${summary.meta.reps} run(s) per fixture and arm, ${summary.meta.date}.\n\n${head}\n${body}\n\n${totals}\n`;
}
