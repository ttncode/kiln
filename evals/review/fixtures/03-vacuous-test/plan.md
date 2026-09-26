# Configurable HTTP timeout

**Goal:** Setting HTTP_TIMEOUT_MS changes how long the HTTP client waits; unset, it waits 5 seconds.

## Global Constraints
- Default stays 5000 ms.

## Review Focus
- none found

### Task 1: config.http.timeoutMs
- Files: src/config.js, test/config.test.js

### Task 2: the client reads it
- Files: src/http.js
