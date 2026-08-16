import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { assertAllowedEditorUrl } = await import('./pods-open-editor.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

describe('assertAllowedEditorUrl', () => {
  test('accepts SharePoint document hosts and the standalone PowerPoint app, HTTPS only', () => {
    expect(assertAllowedEditorUrl('https://contoso-my.sharepoint.com/:p:/r/personal/u/deck.pptx').hostname).toBe(
      'contoso-my.sharepoint.com',
    );
    expect(assertAllowedEditorUrl('https://powerpoint.cloud.microsoft/open/abc').hostname).toBe(
      'powerpoint.cloud.microsoft',
    );
  });

  test('rejects plain HTTP even on an allowed host', () => {
    expect(() => assertAllowedEditorUrl('http://contoso.sharepoint.com/:p:/r/x.pptx')).toThrow(
      FrameBridgeValidationError,
    );
  });

  test('rejects unrelated hosts outright', () => {
    expect(() => assertAllowedEditorUrl('https://evil.com/deck.pptx')).toThrow(FrameBridgeValidationError);
  });

  test('rejects suffix confusion — sharepoint.com must be the registrable suffix, not a substring', () => {
    expect(() => assertAllowedEditorUrl('https://contoso.sharepoint.com.evil.com/x')).toThrow(
      FrameBridgeValidationError,
    );
    expect(() => assertAllowedEditorUrl('https://evil-sharepoint.com/x')).toThrow(FrameBridgeValidationError);
  });

  test('rejects the bare apex — a tenant subdomain is required', () => {
    // endsWith('.sharepoint.com') requires the leading dot, so the apex fails.
    expect(() => assertAllowedEditorUrl('https://sharepoint.com/x')).toThrow(FrameBridgeValidationError);
  });

  test('rejects the userinfo trick — the URL parser resolves the real host past the @', () => {
    expect(() => assertAllowedEditorUrl('https://contoso.sharepoint.com@evil.com/x')).toThrow(
      FrameBridgeValidationError,
    );
  });

  test('rejects non-URLs with a validation error, not a TypeError', () => {
    expect(() => assertAllowedEditorUrl('not a url')).toThrow(FrameBridgeValidationError);
    expect(() => assertAllowedEditorUrl('')).toThrow(FrameBridgeValidationError);
  });
});
