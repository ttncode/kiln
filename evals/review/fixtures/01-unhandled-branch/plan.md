# Status badges on the dashboard

**Goal:** Every dashboard row shows its status label with a colour and an icon.

## Global Constraints
- Keep statusLabel() working for other callers.

## Review Focus
- none found

### Task 1: statusBadge()
- Files: src/status.js, test/status.test.js
- Add statusBadge(status) returning { label, color, icon }.

### Task 2: use it on the dashboard
- Files: src/dashboard.js
