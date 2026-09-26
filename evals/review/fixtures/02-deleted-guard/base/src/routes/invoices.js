const express = require("express");
const { requireAuth } = require("../auth");
const db = require("../db");

const router = express.Router();
const EDITABLE = ["note", "dueDate"];

function pick(body, keys) {
  return Object.fromEntries(keys.filter((key) => key in body).map((key) => [key, body[key]]));
}

router.put("/invoices/:id", requireAuth, async (req, res) => {
  const invoice = await db.invoices.find(req.params.id);
  if (!invoice) return res.status(404).end();
  if (invoice.ownerId !== req.user.id) return res.status(403).end();
  const updated = await db.invoices.update(invoice.id, pick(req.body, EDITABLE));
  res.json(updated);
});

module.exports = router;
