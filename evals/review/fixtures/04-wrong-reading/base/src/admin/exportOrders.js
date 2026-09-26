const db = require("../db");

async function exportOrders() {
  const rows = await db.query("SELECT id, customer_id, total, created_at FROM orders ORDER BY id");
  return rows.map((row) => [row.id, row.customer_id, row.total, row.created_at].join(",")).join("\n");
}

module.exports = { exportOrders };
