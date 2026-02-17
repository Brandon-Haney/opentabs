import { testApi } from './test-api.js';
import { createItem } from './tools/create-item.js';
import { echo } from './tools/echo.js';
import { failingTool } from './tools/failing-tool.js';
import { getStatus } from './tools/get-status.js';
import { greet } from './tools/greet.js';
import { listItems } from './tools/list-items.js';
import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';

class E2eTestPlugin extends OpenTabsPlugin {
  readonly name = 'e2e-test';
  readonly version = '0.0.1';
  readonly description = 'Dead-simple plugin for E2E testing — relays to a local test web server';
  override readonly displayName = 'E2E Test';
  readonly urlPatterns = ['http://localhost/*'];
  readonly tools: ToolDefinition[] = [echo, greet, listItems, getStatus, createItem, failingTool];

  constructor() {
    super();
    // Clear the teardown marker on load so E2E tests can distinguish
    // "teardown called then re-injected" from "just re-injected".
    delete (globalThis as Record<string, unknown>).__opentabs_teardown_called;
  }

  /**
   * Cleanup hook — called by the platform before re-injection or uninstall.
   * Sets markers on the global so E2E tests can verify teardown was called:
   *   - __opentabs_teardown_called: transient (cleared by constructor on re-injection)
   *   - __opentabs_teardown_evidence: persistent (survives re-injection)
   */
  override teardown(): void {
    const g = globalThis as Record<string, unknown>;
    g.__opentabs_teardown_called = true;
    g.__opentabs_teardown_evidence = true;
  }

  /**
   * Readiness probe — calls the test server's auth endpoint via same-origin
   * fetch, exactly like a real plugin (e.g., Slack calls /api/auth.test).
   *
   * The test server's /api/auth.check returns { ok: true } when "logged in"
   * and { ok: false } when the test harness has toggled auth off.
   */
  async isReady(): Promise<boolean> {
    try {
      await testApi('/api/auth.check');
      return true;
    } catch {
      return false;
    }
  }
}

export default new E2eTestPlugin();
