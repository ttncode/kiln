# Invoice update service

**Goal:** The invoice update logic lives in a reusable service; the PUT route behaves exactly as before.

## Global Constraints
- No behaviour change for API callers.

## Review Focus
- none found

### Task 1: extract updateInvoice()
- Files: src/services/invoices.js, src/routes/invoices.js, test/services/invoices.test.js
