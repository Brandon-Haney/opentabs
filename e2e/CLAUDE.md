# E2E Test Instructions

## Overview

Playwright E2E tests that exercise the full stack: MCP server + Chrome extension + test web server + test plugin. Tests run under Playwright's Node.js test runner, so Node.js APIs are correct here.

## Key Files

```
e2e/
├── fixtures.ts        # Test fixtures (MCP server, extension, test server)
├── helpers.ts         # Shared test helpers
├── test-server.ts     # Controllable test web server
└── *.e2e.ts           # Test files
```

## Running Tests

```bash
npm run test:e2e       # Run all E2E tests
```

## Process Cleanup

E2E tests spawn Chromium browsers, MCP server processes, and test servers. You MUST clean up processes you create without killing processes created by other agents running in parallel. Rules:

- **Track PIDs you create.** Before running `npm run test:e2e`, note your own PID (`$$` in bash). After the test run completes (pass or fail), kill only the process tree rooted at the PID you spawned — never `pkill` or `killall` by process name, which would kill other agents' processes too.
- **Playwright handles its own cleanup** in the normal case. The concern is abnormal exits (timeout, crash, `kill -9`). If your test run is interrupted, orphaned Chromium and server processes may survive.
- **Port conflicts are already handled.** All test fixtures use `PORT=0` (ephemeral ports) and Playwright runs with `fullyParallel: true`. Multiple agents running E2E tests simultaneously will not collide on ports.
- **In ralph workers**, process isolation is automatic — ralph runs each worker in its own process group (`set -m`) and kills the entire group (`kill -- -PID`) when the worker finishes, catching any orphaned Chromium/server processes without affecting other workers.

## Node.js APIs

E2E tests run under Playwright's Node.js test runner using Node.js APIs (`node:fs`, `node:child_process`, etc.).

## MCP Server Subprocess

The MCP server test fixture spawns the server using the dev proxy (`dist/dev-proxy.js`) for hot-reload mode, or `dist/index.js --dev` directly for non-hot mode. Hot reload is triggered by POSTing to `/__dev/restart-worker` on the proxy's own port, which restarts the worker and logs `'Hot reload complete'` when the new worker is ready.

Test servers (`test-server.ts`, `strict-csp-test-server.ts`, `analyze-site-test-server.ts`) are TypeScript files run via `node --import tsx/esm`.
