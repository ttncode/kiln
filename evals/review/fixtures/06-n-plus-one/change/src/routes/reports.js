const express = require("express");
const { requireAdmin } = require("../auth");
const db = require("../db");

const router = express.Router();

router.get("/reports/orders", requireAdmin, async (req, res) => {
  const orders = await db.query("SELECT id, customer_id, total FROM orders WHERE created_at >= $1", [req.query.since]);
  for (const order of orders) {
    const [customer] = await db.query("SELECT name, email FROM customers WHERE id = $1", [order.customer_id]);
    order.customerName = customer?.name ?? "(deleted)";
  }
  res.json({ orders });
});

module.exports = router;
