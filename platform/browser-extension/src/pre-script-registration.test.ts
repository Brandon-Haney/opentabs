import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PluginMeta } from './extension-messages.js';

// ---------------------------------------------------------------------------
// Chrome API stubs — must be set up before importing pre-script-registration.ts
// so the module binds to the mocked scripting methods.
// ---------------------------------------------------------------------------

const mockUnregisterContentScripts = vi.fn<(filter: { ids: string[] }) => Promise<void>>();
const mockRegisterContentScripts = vi.fn<(scripts: unknown[]) => Promise<void>>();
const mockGetRegisteredContentScripts = vi.fn<() => Promise<{ id: string }[]>>();

(globalThis as Record<string, unknown>).chrome = {
  scripting: {
    unregisterContentScripts: mockUnregisterContentScripts,
    registerContentScripts: mockRegisterContentScripts,
    getRegisteredContentScripts: mockGetRegisteredContentScripts,
  },
};

// Import after mocking so upsertPreScript binds to the mocked chrome.scripting
const { upsertPreScript } = await import('./pre-script-registration.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseMeta = (): PluginMeta => ({
  name: 'prescript-test',
  version: '1.0.0',
  displayName: 'Prescript Test',
  urlPatterns: ['http://127.0.0.1/*'],
  permission: 'auto',
  tools: [],
});

// ---------------------------------------------------------------------------
// upsertPreScript tests
// ---------------------------------------------------------------------------

describe('upsertPreScript', () => {
  beforeEach(() => {
    // No pre-existing registrations by default, so unregisterIfPresent is a no-op.
    mockGetRegisteredContentScripts.mockResolvedValue([]);
    mockUnregisterContentScripts.mockResolvedValue(undefined);
    mockRegisterContentScripts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('valid preScriptFile', () => {
    test('registers the content script for a well-formed content-hashed filename', async () => {
      const meta = { ...baseMeta(), preScriptFile: 'adapters/prescript-test-prescript-a1b2c3d4.js' };
      await upsertPreScript(meta);
      expect(mockRegisterContentScripts).toHaveBeenCalledOnce();
      expect(mockRegisterContentScripts).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ js: ['adapters/prescript-test-prescript-a1b2c3d4.js'] })]),
      );
    });

    test('registers a single content script when no preScriptFrameMatches are declared', async () => {
      const meta = { ...baseMeta(), preScriptFile: 'adapters/prescript-test-prescript-a1b2c3d4.js' };
      await upsertPreScript(meta);
      const registered = mockRegisterContentScripts.mock.calls[0]?.[0] as { id: string }[];
      expect(registered).toHaveLength(1);
      expect(registered[0]?.id).toBe('opentabs-pre-prescript-test');
    });
  });

  describe('preScriptFrameMatches', () => {
    test('registers a second content script on the embedded-frame patterns', async () => {
      const meta = {
        ...baseMeta(),
        preScriptFile: 'adapters/prescript-test-prescript-a1b2c3d4.js',
        preScriptFrameMatches: ['*://*.officeapps.live.com/*'],
      };
      await upsertPreScript(meta);

      const registered = mockRegisterContentScripts.mock.calls[0]?.[0] as {
        id: string;
        matches: string[];
        allFrames?: boolean;
        world?: string;
        runAt?: string;
        js?: string[];
      }[];
      expect(registered).toHaveLength(2);

      const frame = registered.find(r => r.id === 'opentabs-pre-prescript-test__frames');
      expect(frame).toBeDefined();
      expect(frame?.matches).toEqual(['*://*.officeapps.live.com/*']);
      expect(frame?.allFrames).toBe(true);
      expect(frame?.world).toBe('MAIN');
      expect(frame?.runAt).toBe('document_start');
      // Both registrations point at the same pre-script file.
      expect(frame?.js).toEqual(['adapters/prescript-test-prescript-a1b2c3d4.js']);
    });

    test('ignores an empty preScriptFrameMatches array (single registration)', async () => {
      const meta = {
        ...baseMeta(),
        preScriptFile: 'adapters/prescript-test-prescript-a1b2c3d4.js',
        preScriptFrameMatches: [],
      };
      await upsertPreScript(meta);
      const registered = mockRegisterContentScripts.mock.calls[0]?.[0] as { id: string }[];
      expect(registered).toHaveLength(1);
    });

    test('unregisters only the ids that already exist before re-registering', async () => {
      mockGetRegisteredContentScripts.mockResolvedValue([{ id: 'opentabs-pre-prescript-test' }]);
      const meta = {
        ...baseMeta(),
        preScriptFile: 'adapters/prescript-test-prescript-a1b2c3d4.js',
        preScriptFrameMatches: ['*://*.officeapps.live.com/*'],
      };
      await upsertPreScript(meta);
      // Only the pre-existing main id is unregistered; the not-yet-registered
      // frames id is excluded so the call does not reject atomically.
      expect(mockUnregisterContentScripts).toHaveBeenCalledWith({ ids: ['opentabs-pre-prescript-test'] });
    });
  });

  describe('absent preScriptFile', () => {
    test('returns early without registering when preScriptFile is undefined', async () => {
      await upsertPreScript(baseMeta());
      expect(mockRegisterContentScripts).not.toHaveBeenCalled();
      expect(mockUnregisterContentScripts).not.toHaveBeenCalled();
    });
  });

  describe('malformed preScriptFile — filename validation guard', () => {
    const BAD_PATHS = [
      '../../../etc/passwd',
      'adapters/plugin-abcdef12.js', // missing -prescript- segment
      'evil/prescript-test-prescript-a1b2c3d4.js', // wrong subdirectory
    ];

    for (const badPath of BAD_PATHS) {
      test(`rejects preScriptFile='${badPath}'`, async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const meta = { ...baseMeta(), preScriptFile: badPath };
          await upsertPreScript(meta);
          expect(mockRegisterContentScripts).not.toHaveBeenCalled();
          expect(mockUnregisterContentScripts).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('refusing to register pre-script with unexpected filename'),
          );
        } finally {
          warnSpy.mockRestore();
        }
      });
    }
  });
});
