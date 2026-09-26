const express = require("express");
const { requireAdmin } = require("../auth");
const db = require("../db");

const router = express.Router();

router.get("/admin/ping", requireAdmin, (req, res) => res.json({ ok: true }));

router.get("/admin/audit-events", requireAdmin, async (req, res) => {
  const events = await db.query("SELECT * FROM audit_events ORDER BY created_at DESC");
  res.json({ events });
});

module.exports = router;
