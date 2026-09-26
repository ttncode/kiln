const db = require("../db");

const EDITABLE = ["note", "dueDate"];

function pick(body, keys) {
  return Object.fromEntries(keys.filter((key) => key in body).map((key) => [key, body[key]]));
}

async function updateInvoice(invoice, changes) {
  return db.invoices.update(invoice.id, pick(changes, EDITABLE));
}

module.exports = { updateInvoice, EDITABLE };
