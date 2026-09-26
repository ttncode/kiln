const express = require("express");
const { requireAdmin } = require("../auth");

const router = express.Router();

router.get("/admin/ping", requireAdmin, (req, res) => res.json({ ok: true }));

module.exports = router;
