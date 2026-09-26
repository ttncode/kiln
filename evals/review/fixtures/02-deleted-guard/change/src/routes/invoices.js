const express = require("express");
const { requireAuth } = require("../auth");
const { updateInvoice } = require("../services/invoices");
const db = require("../db");

const router = express.Router();

router.put("/invoices/:id", requireAuth, async (req, res) => {
  const invoice = await db.invoices.find(req.params.id);
  if (!invoice) return res.status(404).end();
  res.json(await updateInvoice(invoice, req.body));
});

module.exports = router;
