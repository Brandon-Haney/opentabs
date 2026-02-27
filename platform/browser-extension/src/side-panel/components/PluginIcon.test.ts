import { AVATAR_PALETTE_SIZE, getAvatarLetter, getAvatarVar, hashString } from './PluginIcon.js';
import { describe, expect, test } from 'vitest';

describe('hashString', () => {
  test('returns an unsigned 32-bit integer', () => {
    const result = hashString('slack');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(result)).toBe(true);
  });

  test('is deterministic — same input always produces same output', () => {
    expect(hashString('slack')).toBe(hashString('slack'));
    expect(hashString('github')).toBe(hashString('github'));
  });

  test('produces different hashes for different inputs', () => {
    const hashes = new Set(['slack', 'github', 'jira', 'notion', 'linear', 'figma'].map(hashString));
    expect(hashes.size).toBe(6);
  });

  test('handles empty string', () => {
    const result = hashString('');
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  test('handles single character', () => {
    expect(Number.isInteger(hashString('a'))).toBe(true);
  });

  test('handles unicode', () => {
    expect(Number.isInteger(hashString('日本語プラグイン'))).toBe(true);
  });
});

describe('getAvatarVar', () => {
  test('returns a CSS variable reference in the correct format', () => {
    const result = getAvatarVar('slack');
    expect(result).toMatch(/^var\(--avatar-\d\)$/);
  });

  test('index is within palette bounds (0–9)', () => {
    const names = [
      'slack',
      'github',
      'jira',
      'notion',
      'linear',
      'figma',
      'vercel',
      'stripe',
      'sentry',
      'postgres',
      'redis',
      'datadog',
      'confluence',
      'bitbucket',
      'gitlab',
      'asana',
      'trello',
      'monday',
      'shopify',
      'zendesk',
      'intercom',
      'hubspot',
      'salesforce',
      'twilio',
    ];
    for (const name of names) {
      const result = getAvatarVar(name);
      const match = /^var\(--avatar-(\d)\)$/.exec(result);
      expect(match).not.toBeNull();
      if (!match) continue;
      const index = Number(match[1]);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(AVATAR_PALETTE_SIZE);
    }
  });

  test('is deterministic — same name always maps to same variable', () => {
    expect(getAvatarVar('slack')).toBe(getAvatarVar('slack'));
    expect(getAvatarVar('github')).toBe(getAvatarVar('github'));
  });

  test('distributes across multiple palette slots', () => {
    const names = [
      'slack',
      'github',
      'jira',
      'notion',
      'linear',
      'figma',
      'vercel',
      'stripe',
      'sentry',
      'postgres',
      'redis',
      'datadog',
      'confluence',
      'bitbucket',
      'gitlab',
      'asana',
      'trello',
      'monday',
    ];
    const slots = new Set(names.map(n => getAvatarVar(n)));
    // 18 plugin names should hit at least 5 of the 10 palette slots
    expect(slots.size).toBeGreaterThanOrEqual(5);
  });
});

describe('getAvatarLetter', () => {
  test('returns first character of displayName, uppercased', () => {
    expect(getAvatarLetter('Slack', 'slack')).toBe('S');
    expect(getAvatarLetter('GitHub', 'github')).toBe('G');
  });

  test('uppercases lowercase first character', () => {
    expect(getAvatarLetter('datadog', 'datadog')).toBe('D');
  });

  test('falls back to pluginName when displayName is empty', () => {
    expect(getAvatarLetter('', 'slack')).toBe('S');
  });

  test('returns ? when both displayName and pluginName are empty', () => {
    expect(getAvatarLetter('', '')).toBe('?');
  });

  test('handles unicode display names', () => {
    expect(getAvatarLetter('日本語', 'japanese')).toBe('日');
  });
});
