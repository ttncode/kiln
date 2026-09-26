const express = require("express");
const { requireAuth } = require("../auth");
const db = require("../db");

const router = express.Router();

router.get("/me/orders", requireAuth, async (req, res) => {
  const orders = await db.query("SELECT id, total, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC", [req.user.id]);
  res.json({ orders });
});

module.exports = router;
