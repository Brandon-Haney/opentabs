import { evaluatePermission, getToolTier, matchDomain, matchesDomainList, TOOL_TIERS } from './permissions.js';
import { createState } from './state.js';
import { describe, expect, test } from 'vitest';
import type { PermissionsConfig } from './config.js';

/** Create a PermissionsConfig with sensible defaults, overridable per-test */
const defaultPermissions = (overrides?: Partial<PermissionsConfig>): PermissionsConfig => ({
  trustedDomains: ['localhost', '127.0.0.1'],
  sensitiveDomains: [],
  toolPolicy: {},
  domainToolPolicy: {},
  ...overrides,
});

describe('matchDomain', () => {
  test('exact match', () => {
    expect(matchDomain('example.com', 'example.com')).toBe(true);
  });

  test('exact mismatch', () => {
    expect(matchDomain('example.com', 'other.com')).toBe(false);
  });

  test('wildcard matches subdomain', () => {
    expect(matchDomain('sub.example.com', '*.example.com')).toBe(true);
  });

  test('wildcard matches deep subdomain', () => {
    expect(matchDomain('a.b.example.com', '*.example.com')).toBe(true);
  });

  test('wildcard does not match the root domain itself', () => {
    expect(matchDomain('example.com', '*.example.com')).toBe(false);
  });

  test('wildcard does not match unrelated domain', () => {
    expect(matchDomain('notexample.com', '*.example.com')).toBe(false);
  });
});

describe('matchesDomainList', () => {
  test('matches any pattern in the list', () => {
    expect(matchesDomainList('sub.example.com', ['localhost', '*.example.com'])).toBe(true);
  });

  test('returns false when no pattern matches', () => {
    expect(matchesDomainList('evil.com', ['localhost', '*.example.com'])).toBe(false);
  });

  test('handles empty list', () => {
    expect(matchesDomainList('anything.com', [])).toBe(false);
  });
});

describe('getToolTier', () => {
  test('observe tier for list_tabs', () => {
    expect(getToolTier('browser_list_tabs')).toBe('observe');
  });

  test('interact tier for click_element', () => {
    expect(getToolTier('browser_click_element')).toBe('interact');
  });

  test('sensitive tier for execute_script', () => {
    expect(getToolTier('browser_execute_script')).toBe('sensitive');
  });

  test('sensitive tier for get_cookies', () => {
    expect(getToolTier('browser_get_cookies')).toBe('sensitive');
  });

  test('sensitive tier for get_storage', () => {
    expect(getToolTier('browser_get_storage')).toBe('sensitive');
  });

  test('unknown tools default to interact', () => {
    expect(getToolTier('browser_unknown_tool')).toBe('interact');
  });

  test('all known browser tools are classified', () => {
    const knownTools = Object.keys(TOOL_TIERS);
    expect(knownTools.length).toBeGreaterThan(30);
  });
});

describe('evaluatePermission — default tier behavior', () => {
  test('observe tier tools default to allow', () => {
    const state = createState();
    state.permissions = defaultPermissions();
    expect(evaluatePermission('browser_list_tabs', 'example.com', state)).toBe('allow');
  });

  test('interact tier tools default to ask', () => {
    const state = createState();
    state.permissions = defaultPermissions({ trustedDomains: [] });
    expect(evaluatePermission('browser_click_element', 'example.com', state)).toBe('ask');
  });

  test('sensitive tier tools default to ask', () => {
    const state = createState();
    state.permissions = defaultPermissions({ trustedDomains: [] });
    expect(evaluatePermission('browser_execute_script', 'example.com', state)).toBe('ask');
  });

  test('null domain uses tier default without trusted domain check', () => {
    const state = createState();
    state.permissions = defaultPermissions();
    // interact tier with null domain — tier default is 'ask', no trusted domain check
    expect(evaluatePermission('browser_click_element', null, state)).toBe('ask');
  });
});

describe('evaluatePermission — bypass flag', () => {
  test('skipConfirmation bypasses all permissions', () => {
    const state = createState();
    state.skipConfirmation = true;
    state.permissions = defaultPermissions({ trustedDomains: [] });
    expect(evaluatePermission('browser_execute_script', 'evil.com', state)).toBe('allow');
  });

  test('skipConfirmation bypasses even deny policies', () => {
    const state = createState();
    state.skipConfirmation = true;
    state.permissions = defaultPermissions({
      toolPolicy: { browser_execute_script: 'deny' },
    });
    expect(evaluatePermission('browser_execute_script', 'example.com', state)).toBe('allow');
  });
});

describe('evaluatePermission — trusted domain override', () => {
  test('trusted domain upgrades interact tier from ask to allow', () => {
    const state = createState();
    state.permissions = defaultPermissions({ trustedDomains: ['localhost'] });
    expect(evaluatePermission('browser_click_element', 'localhost', state)).toBe('allow');
  });

  test('trusted domain upgrades sensitive tier from ask to allow', () => {
    const state = createState();
    state.permissions = defaultPermissions({ trustedDomains: ['localhost'] });
    expect(evaluatePermission('browser_execute_script', 'localhost', state)).toBe('allow');
  });

  test('trusted domain with wildcard pattern', () => {
    const state = createState();
    state.permissions = defaultPermissions({ trustedDomains: ['*.internal.corp'] });
    expect(evaluatePermission('browser_click_element', 'app.internal.corp', state)).toBe('allow');
  });

  test('non-trusted domain does not get upgrade', () => {
    const state = createState();
    state.permissions = defaultPermissions({ trustedDomains: ['localhost'] });
    expect(evaluatePermission('browser_click_element', 'example.com', state)).toBe('ask');
  });
});

describe('evaluatePermission — sensitive domain override', () => {
  test('sensitive domain forces ask even for observe tier', () => {
    const state = createState();
    state.permissions = defaultPermissions({ sensitiveDomains: ['*.chase.com'] });
    // observe tier would normally be 'allow'
    expect(evaluatePermission('browser_list_tabs', 'online.chase.com', state)).toBe('ask');
  });

  test('sensitive domain forces ask for interact tier', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      trustedDomains: ['*.chase.com'],
      sensitiveDomains: ['*.chase.com'],
    });
    // trusted would upgrade to allow, but sensitive takes priority
    expect(evaluatePermission('browser_click_element', 'online.chase.com', state)).toBe('ask');
  });

  test('non-matching sensitive domain has no effect', () => {
    const state = createState();
    state.permissions = defaultPermissions({ sensitiveDomains: ['*.chase.com'] });
    expect(evaluatePermission('browser_list_tabs', 'example.com', state)).toBe('allow');
  });
});

describe('evaluatePermission — per-tool policy', () => {
  test('tool policy overrides tier default', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      trustedDomains: [],
      toolPolicy: { browser_click_element: 'allow' },
    });
    expect(evaluatePermission('browser_click_element', 'example.com', state)).toBe('allow');
  });

  test('tool policy deny overrides everything except bypass', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      trustedDomains: ['example.com'],
      toolPolicy: { browser_list_tabs: 'deny' },
    });
    expect(evaluatePermission('browser_list_tabs', 'example.com', state)).toBe('deny');
  });

  test('tool policy ask overrides observe tier allow', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      toolPolicy: { browser_list_tabs: 'ask' },
    });
    expect(evaluatePermission('browser_list_tabs', 'example.com', state)).toBe('ask');
  });
});

describe('evaluatePermission — per-domain per-tool policy', () => {
  test('domain tool policy overrides everything else', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      sensitiveDomains: ['mail.google.com'],
      toolPolicy: { browser_execute_script: 'deny' },
      domainToolPolicy: {
        'mail.google.com': { browser_execute_script: 'allow' },
      },
    });
    expect(evaluatePermission('browser_execute_script', 'mail.google.com', state)).toBe('allow');
  });

  test('domain tool policy with wildcard', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      domainToolPolicy: {
        '*.google.com': { browser_click_element: 'deny' },
      },
    });
    expect(evaluatePermission('browser_click_element', 'mail.google.com', state)).toBe('deny');
  });

  test('domain tool policy does not affect other tools on same domain', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      trustedDomains: [],
      domainToolPolicy: {
        'example.com': { browser_execute_script: 'allow' },
      },
    });
    // browser_click_element is not in the domainToolPolicy, falls through to tier default
    expect(evaluatePermission('browser_click_element', 'example.com', state)).toBe('ask');
  });

  test('domain tool policy does not affect same tool on other domains', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      trustedDomains: [],
      domainToolPolicy: {
        'example.com': { browser_execute_script: 'allow' },
      },
    });
    expect(evaluatePermission('browser_execute_script', 'other.com', state)).toBe('ask');
  });
});

describe('evaluatePermission — evaluation order', () => {
  test('domainToolPolicy beats sensitiveDomains', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      sensitiveDomains: ['example.com'],
      domainToolPolicy: {
        'example.com': { browser_list_tabs: 'allow' },
      },
    });
    expect(evaluatePermission('browser_list_tabs', 'example.com', state)).toBe('allow');
  });

  test('sensitiveDomains beats toolPolicy', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      sensitiveDomains: ['example.com'],
      toolPolicy: { browser_list_tabs: 'allow' },
    });
    expect(evaluatePermission('browser_list_tabs', 'example.com', state)).toBe('ask');
  });

  test('toolPolicy beats tier default', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      trustedDomains: [],
      toolPolicy: { browser_click_element: 'deny' },
    });
    expect(evaluatePermission('browser_click_element', 'example.com', state)).toBe('deny');
  });

  test('tier default beats trustedDomains for non-ask results', () => {
    const state = createState();
    state.permissions = defaultPermissions({
      trustedDomains: ['example.com'],
    });
    // observe tier default is 'allow' — trusted domain check only triggers for 'ask'
    expect(evaluatePermission('browser_list_tabs', 'example.com', state)).toBe('allow');
  });
});
