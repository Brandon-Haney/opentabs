/**
 * Pre-script lifecycle E2E tests — regression gates for:
 *   (a) plugin.uninstall removes the opentabs-pre-* content script registration (US-005)
 *   (b) plugin.update with a changed preScriptHash registers the new pre-script and leaves open tabs loaded
 *
 * Uses the plain Playwright `test` (not fixture-based) because both tests need
 * bespoke infrastructure: the mock pre-script server, a writable plugin copy
 * for the hash-change test, and direct WebSocket message injection.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS_FILENAME } from '@opentabs-dev/shared';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { cleanupTestConfigDir, launchExtensionContext, startMcpServer, writeTestConfig } from './fixtures.js';
import {
  getExtensionId,
  setupAdapterSymlink,
  startMockPreScriptServer,
  waitForExtensionConnected,
  waitForLog,
  writeAndWaitForWatcher,
} from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PRESCRIPT_PLUGIN_DIR = path.join(ROOT, 'plugins/prescript-test');
const PLUGIN_NAME = 'prescript-test';
const REGISTRATION_ID = `opentabs-pre-${PLUGIN_NAME}`;

// ---------------------------------------------------------------------------
// Helpers local to this file
// ---------------------------------------------------------------------------

/**
 * Navigate to the extension's side panel page, which has access to
 * chrome.runtime.sendMessage for injecting server→extension messages.
 */
const openExtensionPage = async (context: BrowserContext): Promise<Page> => {
  const extId = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/side-panel/side-panel.html`, {
    waitUntil: 'load',
    timeout: 10_000,
  });
  return page;
};

/**
 * Send a simulated server→extension JSON-RPC message by dispatching it
 * through chrome.runtime.sendMessage from an extension page. This triggers
 * the background script's ws:message handler, exercising the same code path
 * as a real WebSocket message.
 */
const sendServerMessage = async (extPage: Page, message: Record<string, unknown>): Promise<void> => {
  await extPage.evaluate(async (msg: Record<string, unknown>) => {
    const chromeApi = (globalThis as Record<string, unknown>).chrome as {
      runtime: { sendMessage: (msg: unknown) => Promise<unknown> };
    };
    await chromeApi.runtime.sendMessage({ type: 'ws:message', data: msg });
  }, message);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Pre-script lifecycle', () => {
  test('uninstall removes the registered pre-script', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-prescript-uninstall-'));
    let server: Awaited<ReturnType<typeof startMcpServer>> | undefined;
    let mock: Awaited<ReturnType<typeof startMockPreScriptServer>> | undefined;
    let context: Awaited<ReturnType<typeof launchExtensionContext>>['context'] | undefined;
    let cleanupDir: string | undefined;

    try {
      writeTestConfig(configDir, {
        localPlugins: [path.resolve(PRESCRIPT_PLUGIN_DIR)],
        permissions: {
          [PLUGIN_NAME]: { permission: 'auto' },
          browser: { permission: 'auto' },
        },
      });

      server = await startMcpServer(configDir, false);
      mock = await startMockPreScriptServer();

      const launched = await launchExtensionContext(server.port, server.secret);
      context = launched.context;
      cleanupDir = launched.cleanupDir;
      setupAdapterSymlink(configDir, launched.extensionDir);

      await waitForExtensionConnected(server);
      await waitForLog(server, 'plugin(s) mapped');

      // Wait for the pre-script to be registered.
      const sw = context.serviceWorkers()[0];
      await expect
        .poll(
          async () => {
            const registered = (await sw?.evaluate(() => chrome.scripting.getRegisteredContentScripts())) as
              | Array<{ id: string }>
              | undefined;
            return registered?.some(r => r.id === REGISTRATION_ID) ?? false;
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      // Send plugin.uninstall via the extension's message handler, simulating
      // the MCP server's uninstall flow. handlePluginUninstall calls removePreScript,
      // which unregisters the content script.
      const extPage = await openExtensionPage(context);
      await sendServerMessage(extPage, {
        jsonrpc: '2.0',
        method: 'plugin.uninstall',
        params: { name: PLUGIN_NAME },
        id: 'test-prescript-uninstall-1',
      });
      await extPage.close();

      // Poll until the registration is absent (5s budget).
      await expect
        .poll(
          async () => {
            const registered = (await sw?.evaluate(() => chrome.scripting.getRegisteredContentScripts())) as
              | Array<{ id: string }>
              | undefined;
            return registered?.some(r => r.id === REGISTRATION_ID) ?? false;
          },
          { timeout: 5_000 },
        )
        .toBe(false);
    } finally {
      await context?.close().catch(() => {});
      await mock?.kill();
      if (server) await server.kill();
      if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
    }
  });

  test('plugin.update with changed preScriptHash registers the new pre-script and leaves open tabs loaded', async () => {
    test.slow();

    // Copy the plugin to an isolated tmp dir so we can modify dist/ freely.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-prescript-copy-'));
    const pluginCopyDir = path.join(tmpDir, PLUGIN_NAME);
    fs.cpSync(PRESCRIPT_PLUGIN_DIR, pluginCopyDir, { recursive: true });

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-e2e-prescript-hashchange-'));
    let server: Awaited<ReturnType<typeof startMcpServer>> | undefined;
    let mock: Awaited<ReturnType<typeof startMockPreScriptServer>> | undefined;
    let context: Awaited<ReturnType<typeof launchExtensionContext>>['context'] | undefined;
    let cleanupDir: string | undefined;

    try {
      writeTestConfig(configDir, {
        localPlugins: [pluginCopyDir],
        permissions: {
          [PLUGIN_NAME]: { permission: 'auto' },
          browser: { permission: 'auto' },
        },
      });

      // Dev mode is required for the file watcher to detect dist/ changes.
      server = await startMcpServer(configDir, true);
      mock = await startMockPreScriptServer();

      const launched = await launchExtensionContext(server.port, server.secret);
      context = launched.context;
      cleanupDir = launched.cleanupDir;
      setupAdapterSymlink(configDir, launched.extensionDir);

      await waitForExtensionConnected(server);
      await waitForLog(server, 'plugin(s) mapped');

      // Wait for the pre-script to be registered before navigating.
      const sw = context.serviceWorkers()[0];
      await expect
        .poll(
          async () => {
            const registered = (await sw?.evaluate(() => chrome.scripting.getRegisteredContentScripts())) as
              | Array<{ id: string }>
              | undefined;
            return registered?.some(r => r.id === REGISTRATION_ID) ?? false;
          },
          { timeout: 10_000 },
        )
        .toBe(true);

      // Open the mock page — the pre-script runs at document_start.
      const page = await context.newPage();
      await page.goto(mock.url, { waitUntil: 'load' });

      // A value set on the page survives only as long as the page is not reloaded.
      await page.evaluate(() => {
        (window as unknown as Record<string, unknown>).__noReloadSentinel = true;
      });
      const readSentinel = () =>
        page.evaluate(() => (window as unknown as Record<string, unknown>).__noReloadSentinel === true);

      const registeredJsPaths = async (): Promise<string[]> => {
        const registered = (await sw?.evaluate(() => chrome.scripting.getRegisteredContentScripts())) as
          | Array<{ id: string; js?: string[] }>
          | undefined;
        return registered?.find(r => r.id === REGISTRATION_ID)?.js ?? [];
      };
      const originalJsPaths = await registeredJsPaths();

      // Read current dist files so we can modify them with predictable content.
      const preScriptIifePath = path.join(pluginCopyDir, 'dist', 'pre-script.iife.js');
      const toolsJsonPath = path.join(pluginCopyDir, 'dist', TOOLS_FILENAME);
      const originalPreScript = fs.readFileSync(preScriptIifePath, 'utf-8');
      const parsedTools = JSON.parse(fs.readFileSync(toolsJsonPath, 'utf-8')) as Record<string, unknown>;

      // Modify dist/pre-script.iife.js and dist/tools.json in the writeFile
      // callback so writeAndWaitForWatcher can retry with distinct content if
      // the file watcher misses the first write.
      await writeAndWaitForWatcher(
        server,
        (attempt: number) => {
          // Append a unique marker so each retry produces a different mtime AND content.
          const modifiedPreScript = `${originalPreScript}\n// e2e-hashchange-${attempt}`;
          const newHash = crypto.createHash('sha256').update(modifiedPreScript).digest('hex');
          fs.writeFileSync(preScriptIifePath, modifiedPreScript, 'utf-8');
          fs.writeFileSync(toolsJsonPath, JSON.stringify({ ...parsedTools, preScriptHash: newHash }), 'utf-8');
        },
        `File watcher: ${TOOLS_FILENAME} updated for`,
      );

      // The file watcher detected the tools.json change, re-read the new
      // preScriptHash from state, and sent plugin.update to the extension.
      // The extension registers the new pre-script file for future page loads.
      await expect.poll(registeredJsPaths, { timeout: 15_000 }).not.toEqual(originalJsPaths);

      // The update handler is done with the tab once this settles, so the sentinel
      // still being there means the open tab was left alone.
      await page.waitForTimeout(2_000);
      expect(await readSentinel()).toBe(true);

      // The sentinel does disappear on a real reload.
      await page.reload({ waitUntil: 'load' });
      expect(await readSentinel()).toBe(false);
    } finally {
      await context?.close().catch(() => {});
      await mock?.kill();
      if (server) await server.kill();
      if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
      cleanupTestConfigDir(configDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
