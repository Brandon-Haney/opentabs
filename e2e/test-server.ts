/**
 * Controllable test web server for E2E tests.
 *
 * Simulates a real web application (like Slack) that an OpenTabs plugin
 * targets. The plugin's IIFE is injected into a tab opened to this server,
 * and the plugin's tools call this server's internal API endpoints via
 * same-origin fetch — exactly like a real plugin would.
 *
 * Three categories of endpoints:
 *
 * 1. **Page** — serves the HTML "app" at `/` that the browser opens.
 * 2. **Internal API** — endpoints the plugin calls via fetch:
 *      POST /api/auth.check   — readiness probe (isReady)
 *      POST /api/echo         — echo a message back
 *      POST /api/greet        — compute a greeting
 *      POST /api/list-items   — return a paginated list
 *      POST /api/status       — return server status (zero-input)
 *      POST /api/create-item  — create a new item
 *      POST /api/fail         — always returns an error
 * 3. **Control** — endpoints the test harness uses to toggle behaviour:
 *      POST /control/set-auth        — { authenticated: boolean }
 *      POST /control/set-error       — { error: boolean } (all API 500s)
 *      POST /control/set-slow        — { delayMs: number } (add latency)
 *      GET  /control/invocations     — list of all API calls received
 *      POST /control/reset           — reset all state to defaults
 *      GET  /control/health          — simple health check
 *
 * Start: `bun e2e/test-server.ts`
 * Default port: 9516 (override with PORT env var)
 */

import {
  jsonResponse as sharedJsonResponse,
  readBody,
  recordInvocation as sharedRecordInvocation,
  requireAuth as sharedRequireAuth,
} from './test-server-utils.js';
import type { Invocation } from './test-server-utils.js';

// ---------------------------------------------------------------------------
// State — mutated by /control endpoints, read by /api endpoints
// ---------------------------------------------------------------------------

interface ServerState {
  authenticated: boolean;
  errorMode: boolean;
  delayMs: number;
  invocations: Invocation[];
  items: Array<{
    id: string;
    name: string;
    description: string;
    created_at: string;
  }>;
  nextItemId: number;
  startedAt: number;
  flakyCallCount: number;
}

const createDefaultState = (): ServerState => ({
  authenticated: true,
  errorMode: false,
  delayMs: 0,
  invocations: [],
  items: [
    {
      id: 'item-1',
      name: 'Alpha',
      description: 'First item',
      created_at: new Date().toISOString(),
    },
    {
      id: 'item-2',
      name: 'Bravo',
      description: 'Second item',
      created_at: new Date().toISOString(),
    },
    {
      id: 'item-3',
      name: 'Charlie',
      description: 'Third item',
      created_at: new Date().toISOString(),
    },
    {
      id: 'item-4',
      name: 'Delta',
      description: 'Fourth item',
      created_at: new Date().toISOString(),
    },
    {
      id: 'item-5',
      name: 'Echo',
      description: 'Fifth item',
      created_at: new Date().toISOString(),
    },
  ],
  nextItemId: 6,
  startedAt: Date.now(),
  flakyCallCount: 0,
});

let state = createDefaultState();

// ---------------------------------------------------------------------------
// Helpers — thin wrappers around shared utilities with server-specific state
// ---------------------------------------------------------------------------

const jsonResponse = (data: unknown, status = 200) => sharedJsonResponse(data, status, true);

const recordInvocation = (req: Request, path: string, body: unknown) => {
  sharedRecordInvocation(state.invocations, req, path, body);
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * If error mode is on, return a 500 JSON error. If delay mode is on, wait.
 * Returns a Response if the request should be short-circuited, or null to continue.
 */
const maybeShortCircuit = async (): Promise<Response | null> => {
  if (state.delayMs > 0) {
    await sleep(state.delayMs);
  }
  if (state.errorMode) {
    return jsonResponse(
      {
        ok: false,
        error: 'server_error',
        error_message: 'Error mode is enabled',
      },
      500,
    );
  }
  return null;
};

const requireAuth = (): Response | null => sharedRequireAuth(state.authenticated, jsonResponse);

// ---------------------------------------------------------------------------
// Page HTML — the "web app" that the browser tab opens
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>E2E Test App</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #333; }
    .status { padding: 8px 16px; border-radius: 6px; display: inline-block; margin: 4px 0; }
    .ok { background: #d4edda; color: #155724; }
    .err { background: #f8d7da; color: #721c24; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
    #log { font-family: monospace; font-size: 12px; background: #1e1e1e; color: #d4d4d4;
           padding: 12px; border-radius: 6px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>🧪 E2E Test App</h1>
  <p>This page simulates a web application targeted by the <code>e2e-test</code> OpenTabs plugin.</p>
  <p>Auth status: <span id="auth" class="status">checking…</span></p>
  <p>Plugin adapter: <span id="adapter" class="status">checking…</span></p>
  <h3>Console log</h3>
  <div id="log"></div>
  <script src="/test-script.js"></script>
  <script>
    // Poll auth status
    async function checkAuth() {
      try {
        const res = await fetch('/api/auth.check', { method: 'POST' });
        const data = await res.json();
        const el = document.getElementById('auth');
        el.textContent = data.ok ? 'Authenticated ✓' : 'Not authenticated ✗';
        el.className = 'status ' + (data.ok ? 'ok' : 'err');
      } catch (e) {
        const el = document.getElementById('auth');
        el.textContent = 'Server unreachable';
        el.className = 'status err';
      }
    }
    checkAuth();
    setInterval(checkAuth, 3000);

    // Check if adapter is injected
    function checkAdapter() {
      const ot = window.__openTabs;
      const el = document.getElementById('adapter');
      if (ot && ot.adapters && ot.adapters['e2e-test']) {
        el.textContent = 'Injected ✓';
        el.className = 'status ok';
      } else {
        el.textContent = 'Not injected';
        el.className = 'status err';
      }
    }
    checkAdapter();
    setInterval(checkAdapter, 1000);

    // Capture console.warn for display (OpenTabs logs tool invocations here)
    const origWarn = console.warn;
    const logEl = document.getElementById('log');
    console.warn = function(...args) {
      origWarn.apply(console, args);
      const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      logEl.textContent += text + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
    };
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Interactive test page HTML — for DOM interaction E2E tests
// ---------------------------------------------------------------------------

const INTERACTIVE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Interactive Test Page</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    label { display: block; margin: 8px 0 4px; }
  </style>
</head>
<body>
  <h1>Interactive Test Page</h1>

  <button id="test-btn">Click me</button>
  <input id="test-input" type="text" placeholder="Type here" />
  <textarea id="test-textarea" placeholder="Textarea"></textarea>

  <select id="test-select">
    <option value="a">Alpha</option>
    <option value="b">Beta</option>
    <option value="c">Gamma</option>
  </select>

  <div id="delayed-content" style="display:none">Delayed content loaded</div>
  <span id="status">ready</span>

  <!-- Input for Enter key testing (keydown listener detects Enter) -->
  <input id="form-input" type="text" placeholder="Press Enter" />

  <!-- Hover target -->
  <div id="hover-target" style="padding:10px;border:1px solid #ccc;">Hover me</div>

  <!-- Alert trigger -->
  <button id="show-alert" onclick="alert('test-alert')">Show Alert</button>

  <!-- Long scrollable section for scroll testing -->
  <div id="scroll-section" style="height:2000px;background:linear-gradient(white,lightgray);position:relative;">
    <div id="scroll-bottom" style="position:absolute;bottom:0;">Bottom marker</div>
  </div>

  <script>
    document.getElementById('test-btn').addEventListener('click', function() {
      window.__btnClicked = true;
    });

    setTimeout(function() {
      document.getElementById('delayed-content').style.display = 'block';
    }, 500);

    document.addEventListener('keydown', function(e) {
      window.__lastKeydown = e.key;
    });

    document.getElementById('form-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') window.__formSubmitted = true;
    });

    document.getElementById('hover-target').addEventListener('mouseenter', function() {
      window.__hovered = true;
    });
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// SDK utilities test page HTML — for SDK E2E tests (US-006)
// ---------------------------------------------------------------------------

const SDK_TEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SDK Test Page</title>
</head>
<body>
  <h1>SDK Utilities Test Page</h1>
  <p id="known-text">Hello from SDK test</p>

  <script>
    // Set localStorage value for getLocalStorage testing
    localStorage.setItem('sdk-test-key', 'sdk-test-value');

    // Set a global for getPageGlobal testing
    window.__sdkTestGlobal = { nested: { value: 42 } };

    // Add a delayed element for waitForSelector testing (appears after 500ms)
    setTimeout(function() {
      var el = document.createElement('div');
      el.id = 'delayed-element';
      el.textContent = 'Delayed element appeared';
      document.body.appendChild(el);
    }, 500);
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 9516;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- CORS preflight ---
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // --- Page ---
    if (path === '/' || path === '/index.html') {
      return new Response(PAGE_HTML, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // --- External JS file (loaded by the main page for CDP resource tests) ---
    if (path === '/test-script.js') {
      return new Response('window.__testScriptLoaded = true;\n', {
        headers: { 'Content-Type': 'application/javascript' },
      });
    }

    // --- Interactive test page (for DOM interaction E2E tests) ---
    if (path === '/interactive') {
      return new Response(INTERACTIVE_HTML, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // --- POST test page (for network body capture E2E tests) ---
    // Loads, then immediately sends a POST to /api/echo with a JSON body
    if (path === '/post-test') {
      const postTestHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><title>POST Test Page</title></head>
<body>
  <p id="status">sending...</p>
  <script>
    fetch('/api/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test-body-e2e' })
    })
      .then(r => r.json())
      .then(data => { document.getElementById('status').textContent = 'done: ' + JSON.stringify(data); })
      .catch(err => { document.getElementById('status').textContent = 'error: ' + err.message; });
  </script>
</body>
</html>`;
      return new Response(postTestHtml, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // --- SDK utilities test page ---
    if (path === '/sdk-test') {
      return new Response(SDK_TEST_HTML, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // =======================================================================
    // Control endpoints (called by the test harness, not by the plugin)
    // =======================================================================

    if (path === '/control/set-auth' && req.method === 'POST') {
      const body = await readBody(req);
      state.authenticated = body.authenticated === true;
      return jsonResponse({ ok: true, authenticated: state.authenticated });
    }

    if (path === '/control/set-error' && req.method === 'POST') {
      const body = await readBody(req);
      state.errorMode = body.error === true;
      return jsonResponse({ ok: true, errorMode: state.errorMode });
    }

    if (path === '/control/set-slow' && req.method === 'POST') {
      const body = await readBody(req);
      state.delayMs = typeof body.delayMs === 'number' ? body.delayMs : 0;
      return jsonResponse({ ok: true, delayMs: state.delayMs });
    }

    if (path === '/control/invocations' && req.method === 'GET') {
      return jsonResponse({ ok: true, invocations: state.invocations });
    }

    if (path === '/control/reset' && req.method === 'POST') {
      state = createDefaultState();
      return jsonResponse({ ok: true });
    }

    if (path === '/control/health' && req.method === 'GET') {
      return jsonResponse({
        ok: true,
        port: PORT,
        uptime: (Date.now() - state.startedAt) / 1000,
      });
    }

    if (path === '/control/diagnostics' && req.method === 'GET') {
      const authCheckCalls = state.invocations.filter(i => i.path === '/api/auth.check');
      const toolCalls = state.invocations.filter(i => i.path !== '/api/auth.check');
      return jsonResponse({
        ok: true,
        server: {
          port: PORT,
          uptime: Math.floor((Date.now() - state.startedAt) / 1000),
          authenticated: state.authenticated,
          errorMode: state.errorMode,
          delayMs: state.delayMs,
        },
        counts: {
          totalInvocations: state.invocations.length,
          authCheckCalls: authCheckCalls.length,
          toolCalls: toolCalls.length,
          items: state.items.length,
        },
        recentInvocations: state.invocations.slice(-10).map(i => ({
          ts: i.ts,
          path: i.path,
          method: i.method,
          age: `${Date.now() - i.ts}ms ago`,
        })),
        // Has any page ever hit /api/auth.check? If yes, the adapter is alive
        // and calling isReady(). If zero, the adapter was never injected or
        // never ran isReady().
        adapterLikelyInjected: authCheckCalls.length > 0,
      });
    }

    // =======================================================================
    // Internal API endpoints (called by the plugin via same-origin fetch)
    // =======================================================================

    // --- Auth check (used by isReady) ---
    // Readiness probes are excluded from the artificial delay so that slow-mode
    // testing targets tool execution latency, not the health check itself.
    if (path === '/api/auth.check' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      if (state.errorMode) {
        return jsonResponse({ ok: false, error: 'server_error', error_message: 'Error mode is enabled' }, 500);
      }
      return jsonResponse({ ok: state.authenticated });
    }

    // --- Echo ---
    if (path === '/api/echo' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      const sc = await maybeShortCircuit();
      if (sc) return sc;
      const authErr = requireAuth();
      if (authErr) return authErr;
      return jsonResponse({ ok: true, message: body.message ?? '' });
    }

    // --- Greet ---
    if (path === '/api/greet' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      const sc = await maybeShortCircuit();
      if (sc) return sc;
      const authErr = requireAuth();
      if (authErr) return authErr;
      const name = typeof body.name === 'string' ? body.name : 'World';
      return jsonResponse({ ok: true, greeting: `Hello, ${name}!` });
    }

    // --- List items ---
    if (path === '/api/list-items' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      const sc = await maybeShortCircuit();
      if (sc) return sc;
      const authErr = requireAuth();
      if (authErr) return authErr;
      const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 100);
      const offset = Math.max(Number(body.offset) || 0, 0);
      const sliced = state.items.slice(offset, offset + limit);
      return jsonResponse({
        ok: true,
        items: sliced.map(i => ({ id: i.id, name: i.name })),
        total: state.items.length,
      });
    }

    // --- Status ---
    if (path === '/api/status' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      const sc = await maybeShortCircuit();
      if (sc) return sc;
      return jsonResponse({
        ok: true,
        authenticated: state.authenticated,
        uptime: Math.floor((Date.now() - state.startedAt) / 1000),
        version: '1.0.0-test',
      });
    }

    // --- Create item ---
    if (path === '/api/create-item' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      const sc = await maybeShortCircuit();
      if (sc) return sc;
      const authErr = requireAuth();
      if (authErr) return authErr;
      const name = typeof body.name === 'string' ? body.name : 'Unnamed';
      const description = typeof body.description === 'string' ? body.description : '';
      const item = {
        id: `item-${state.nextItemId++}`,
        name,
        description,
        created_at: new Date().toISOString(),
      };
      state.items.push(item);
      return jsonResponse({ ok: true, item });
    }

    // --- Fail (always returns error) ---
    if (path === '/api/fail' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      const sc = await maybeShortCircuit();
      if (sc) return sc;
      // Always fail, even if auth is fine — this endpoint is for testing error propagation
      const errorCode = typeof body.error_code === 'string' ? body.error_code : 'deliberate_failure';
      const errorMessage = typeof body.error_message === 'string' ? body.error_message : 'This tool always fails';
      return jsonResponse({
        ok: false,
        error: errorCode,
        error_code: errorCode,
        error_message: errorMessage,
      });
    }

    // --- Flaky endpoint (fails first N calls, then succeeds) ---
    // Used to test sdk.retry. The first 3 calls return 500, subsequent calls succeed.
    // Reset via POST /control/reset.
    if (path === '/api/flaky' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      state.flakyCallCount++;
      if (state.flakyCallCount <= 3) {
        return jsonResponse(
          { ok: false, error: 'flaky_error', error_message: `Flaky failure (attempt ${state.flakyCallCount})` },
          500,
        );
      }
      return jsonResponse({ ok: true, data: 'flaky-success', attempts: state.flakyCallCount });
    }

    // --- SDK fetch test endpoint ---
    if (path === '/api/sdk-fetch-test' && req.method === 'POST') {
      const body = await readBody(req);
      recordInvocation(req, path, body);
      const sc = await maybeShortCircuit();
      if (sc) return sc;
      return jsonResponse({ ok: true, data: 'sdk-fetch-works' });
    }

    // --- Configurable HTTP status code endpoint ---
    // Returns the requested status code with an appropriate body.
    // Used by E2E tests for fetchFromPage error categorization.
    const statusCodeMatch = path.match(/^\/api\/status-code\/(\d+)$/);
    if (statusCodeMatch && req.method === 'GET') {
      const code = Number(statusCodeMatch[1]);
      recordInvocation(req, path, {});
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      };
      if (code === 429) {
        headers['Retry-After'] = '3';
      }
      return new Response(
        JSON.stringify({ ok: false, error: `status_${code}`, error_message: `Returned status ${code}` }),
        { status: code, headers },
      );
    }

    // --- Slow-forever endpoint (never responds) ---
    // Used by E2E tests to verify fetchFromPage timeout handling.
    if (path === '/api/slow-forever' && req.method === 'GET') {
      recordInvocation(req, path, {});
      await new Promise(() => {
        // Intentionally never resolves — the client's AbortSignal will abort
      });
      return new Response('unreachable', { status: 500 });
    }

    // --- 404 ---
    return new Response('Not found', { status: 404 });
  },
});

console.log(`[e2e-test-server] Listening on http://localhost:${String(server.port)}`);

// Ensure the process exits on SIGTERM/SIGINT so parent kill() calls
// reliably terminate the subprocess (Bun.serve keeps the event loop alive).
const shutdown = () => {
  void server.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Export for programmatic use in tests
export { server, state };
export type { ServerState, Invocation };
