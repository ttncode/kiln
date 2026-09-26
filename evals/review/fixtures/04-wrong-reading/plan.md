# Hide archived orders

**Goal:** Archived orders no longer appear in the order list.

## Global Constraints
- Archived orders are kept, not deleted.

## Review Focus
- none found

### Task 1: archived column
- Files: migrations/0042_orders_archived.sql

### Task 2: filter archived orders
- Files: src/admin/exportOrders.js, test/admin/exportOrders.test.js
