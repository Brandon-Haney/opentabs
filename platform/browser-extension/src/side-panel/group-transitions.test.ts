import { describe, expect, test } from 'vitest';
import type { GroupablePlugin } from './group-transitions.js';
import {
  buildStateSnapshot,
  collapseTransitioningItems,
  detectGroupChanges,
  getTransitionClass,
  groupPlugins,
} from './group-transitions.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const plugin = (name: string, tabState: 'ready' | 'unavailable' | 'closed'): GroupablePlugin => ({
  name,
  tabState,
});

// ─── groupPlugins ────────────────────────────────────────────────────────────

describe('groupPlugins', () => {
  test('empty input returns empty groups', () => {
    const result = groupPlugins([]);
    expect(result.ready).toEqual([]);
    expect(result.notReady).toEqual([]);
  });

  test('all ready plugins go to ready group', () => {
    const plugins = [plugin('slack', 'ready'), plugin('github', 'ready')];
    const result = groupPlugins(plugins);
    expect(result.ready.map(p => p.name)).toEqual(['slack', 'github']);
    expect(result.notReady).toEqual([]);
  });

  test('all not-ready plugins go to notReady group', () => {
    const plugins = [plugin('slack', 'closed'), plugin('github', 'unavailable')];
    const result = groupPlugins(plugins);
    expect(result.ready).toEqual([]);
    expect(result.notReady.map(p => p.name)).toEqual(['slack', 'github']);
  });

  test('mixed readiness splits correctly', () => {
    const plugins = [
      plugin('slack', 'ready'),
      plugin('github', 'closed'),
      plugin('discord', 'ready'),
      plugin('linear', 'unavailable'),
    ];
    const result = groupPlugins(plugins);
    expect(result.ready.map(p => p.name)).toEqual(['slack', 'discord']);
    expect(result.notReady.map(p => p.name)).toEqual(['github', 'linear']);
  });

  test('preserves original order within each group', () => {
    const plugins = [
      plugin('a', 'ready'),
      plugin('b', 'closed'),
      plugin('c', 'ready'),
      plugin('d', 'closed'),
      plugin('e', 'ready'),
    ];
    const result = groupPlugins(plugins);
    expect(result.ready.map(p => p.name)).toEqual(['a', 'c', 'e']);
    expect(result.notReady.map(p => p.name)).toEqual(['b', 'd']);
  });

  test('unavailable is treated as not-ready (same as closed)', () => {
    const result = groupPlugins([plugin('x', 'unavailable')]);
    expect(result.ready).toEqual([]);
    expect(result.notReady.map(p => p.name)).toEqual(['x']);
  });

  test('single ready plugin', () => {
    const result = groupPlugins([plugin('solo', 'ready')]);
    expect(result.ready.map(p => p.name)).toEqual(['solo']);
    expect(result.notReady).toEqual([]);
  });

  test('single not-ready plugin', () => {
    const result = groupPlugins([plugin('solo', 'closed')]);
    expect(result.ready).toEqual([]);
    expect(result.notReady.map(p => p.name)).toEqual(['solo']);
  });
});

// ─── buildStateSnapshot ──────────────────────────────────────────────────────

describe('buildStateSnapshot', () => {
  test('empty input returns empty map', () => {
    expect(buildStateSnapshot([])).toEqual(new Map());
  });

  test('captures all plugin states', () => {
    const snap = buildStateSnapshot([
      plugin('slack', 'ready'),
      plugin('github', 'closed'),
      plugin('discord', 'unavailable'),
    ]);
    expect(snap.get('slack')).toBe('ready');
    expect(snap.get('github')).toBe('closed');
    expect(snap.get('discord')).toBe('unavailable');
    expect(snap.size).toBe(3);
  });
});

// ─── detectGroupChanges ──────────────────────────────────────────────────────

describe('detectGroupChanges', () => {
  test('no previous state → no changes (all plugins are new)', () => {
    const prev = new Map<string, 'ready' | 'unavailable' | 'closed'>();
    const current = [plugin('slack', 'ready')];
    expect(detectGroupChanges(prev, current)).toEqual(new Set());
  });

  test('identical states → no changes', () => {
    const prev = buildStateSnapshot([plugin('slack', 'ready'), plugin('github', 'closed')]);
    const current = [plugin('slack', 'ready'), plugin('github', 'closed')];
    expect(detectGroupChanges(prev, current)).toEqual(new Set());
  });

  test('ready → closed detected as change', () => {
    const prev = buildStateSnapshot([plugin('slack', 'ready')]);
    const current = [plugin('slack', 'closed')];
    const changed = detectGroupChanges(prev, current);
    expect(changed).toEqual(new Set(['slack']));
  });

  test('ready → unavailable detected as change', () => {
    const prev = buildStateSnapshot([plugin('slack', 'ready')]);
    const current = [plugin('slack', 'unavailable')];
    const changed = detectGroupChanges(prev, current);
    expect(changed).toEqual(new Set(['slack']));
  });

  test('closed → ready detected as change', () => {
    const prev = buildStateSnapshot([plugin('slack', 'closed')]);
    const current = [plugin('slack', 'ready')];
    const changed = detectGroupChanges(prev, current);
    expect(changed).toEqual(new Set(['slack']));
  });

  test('unavailable → ready detected as change', () => {
    const prev = buildStateSnapshot([plugin('slack', 'unavailable')]);
    const current = [plugin('slack', 'ready')];
    const changed = detectGroupChanges(prev, current);
    expect(changed).toEqual(new Set(['slack']));
  });

  test('closed → unavailable is NOT a group change (both are not-ready)', () => {
    const prev = buildStateSnapshot([plugin('slack', 'closed')]);
    const current = [plugin('slack', 'unavailable')];
    expect(detectGroupChanges(prev, current)).toEqual(new Set());
  });

  test('unavailable → closed is NOT a group change (both are not-ready)', () => {
    const prev = buildStateSnapshot([plugin('slack', 'unavailable')]);
    const current = [plugin('slack', 'closed')];
    expect(detectGroupChanges(prev, current)).toEqual(new Set());
  });

  test('multiple plugins, only some change groups', () => {
    const prev = buildStateSnapshot([plugin('slack', 'ready'), plugin('github', 'closed'), plugin('discord', 'ready')]);
    const current = [
      plugin('slack', 'closed'), // changed: ready → closed
      plugin('github', 'closed'), // unchanged
      plugin('discord', 'ready'), // unchanged
    ];
    const changed = detectGroupChanges(prev, current);
    expect(changed).toEqual(new Set(['slack']));
  });

  test('multiple plugins all change groups simultaneously', () => {
    const prev = buildStateSnapshot([plugin('slack', 'ready'), plugin('github', 'closed'), plugin('discord', 'ready')]);
    const current = [plugin('slack', 'closed'), plugin('github', 'ready'), plugin('discord', 'unavailable')];
    const changed = detectGroupChanges(prev, current);
    expect(changed).toEqual(new Set(['slack', 'github', 'discord']));
  });

  test('new plugin appearing in current is not treated as a change', () => {
    const prev = buildStateSnapshot([plugin('slack', 'ready')]);
    const current = [plugin('slack', 'ready'), plugin('new-plugin', 'closed')];
    expect(detectGroupChanges(prev, current)).toEqual(new Set());
  });

  test('plugin disappearing from current is ignored (no crash)', () => {
    const prev = buildStateSnapshot([plugin('slack', 'ready'), plugin('removed', 'closed')]);
    const current = [plugin('slack', 'ready')];
    expect(detectGroupChanges(prev, current)).toEqual(new Set());
  });

  test('rapid ready → closed → ready is detected on each step', () => {
    // Step 1: ready → closed
    const snap1 = buildStateSnapshot([plugin('slack', 'ready')]);
    const step1 = [plugin('slack', 'closed')];
    expect(detectGroupChanges(snap1, step1)).toEqual(new Set(['slack']));

    // Step 2: closed → ready
    const snap2 = buildStateSnapshot(step1);
    const step2 = [plugin('slack', 'ready')];
    expect(detectGroupChanges(snap2, step2)).toEqual(new Set(['slack']));
  });
});

// ─── getTransitionClass ──────────────────────────────────────────────────────

describe('getTransitionClass', () => {
  test('returns undefined for non-animating plugin', () => {
    expect(getTransitionClass('slack', true, new Set())).toBeUndefined();
    expect(getTransitionClass('slack', false, new Set())).toBeUndefined();
    expect(getTransitionClass('slack', true, new Set(['github']))).toBeUndefined();
  });

  test('returns fade-in class for animating plugin moving to ready group', () => {
    const animating = new Set(['slack']);
    expect(getTransitionClass('slack', true, animating)).toBe('animate-group-fade-in');
  });

  test('returns dim fade-in class for animating plugin moving to not-ready group', () => {
    const animating = new Set(['slack']);
    expect(getTransitionClass('slack', false, animating)).toBe('animate-group-fade-in-dim');
  });

  test('only the animating plugin gets the class, others do not', () => {
    const animating = new Set(['slack']);
    expect(getTransitionClass('slack', true, animating)).toBe('animate-group-fade-in');
    expect(getTransitionClass('github', true, animating)).toBeUndefined();
    expect(getTransitionClass('discord', false, animating)).toBeUndefined();
  });

  test('multiple animating plugins each get their own class', () => {
    const animating = new Set(['slack', 'github']);
    expect(getTransitionClass('slack', true, animating)).toBe('animate-group-fade-in');
    expect(getTransitionClass('github', false, animating)).toBe('animate-group-fade-in-dim');
  });
});

// ─── collapseTransitioningItems ──────────────────────────────────────────────

describe('collapseTransitioningItems', () => {
  test('empty animating set returns original array (same reference)', () => {
    const open = ['slack', 'github'];
    const result = collapseTransitioningItems(open, new Set());
    expect(result).toBe(open); // same reference, not a copy
  });

  test('removes animating plugin from open list', () => {
    const open = ['slack', 'github', 'discord'];
    const animating = new Set(['github']);
    expect(collapseTransitioningItems(open, animating)).toEqual(['slack', 'discord']);
  });

  test('removes multiple animating plugins from open list', () => {
    const open = ['slack', 'github', 'discord'];
    const animating = new Set(['slack', 'discord']);
    expect(collapseTransitioningItems(open, animating)).toEqual(['github']);
  });

  test('returns original array reference when no items match', () => {
    const open = ['slack', 'github'];
    const animating = new Set(['discord']);
    const result = collapseTransitioningItems(open, animating);
    expect(result).toBe(open); // same reference, nothing removed
  });

  test('returns empty array when all items are animating', () => {
    const open = ['slack', 'github'];
    const animating = new Set(['slack', 'github']);
    expect(collapseTransitioningItems(open, animating)).toEqual([]);
  });

  test('handles empty open list', () => {
    const open: string[] = [];
    const animating = new Set(['slack']);
    const result = collapseTransitioningItems(open, animating);
    expect(result).toBe(open);
  });

  test('plugin expanded in ready group is collapsed when it transitions to not-ready', () => {
    // Scenario: slack is expanded in the ready accordion, then becomes not-ready
    const readyOpen = ['slack', 'github'];
    const notReadyOpen: string[] = [];
    const animating = new Set(['slack']); // slack is transitioning

    const newReadyOpen = collapseTransitioningItems(readyOpen, animating);
    const newNotReadyOpen = collapseTransitioningItems(notReadyOpen, animating);

    expect(newReadyOpen).toEqual(['github']); // slack removed
    expect(newNotReadyOpen).toEqual([]); // nothing to remove, slack arrives collapsed
  });

  test('plugin expanded in not-ready group is collapsed when it transitions to ready', () => {
    // Scenario: discord is expanded in the not-ready accordion, then becomes ready
    const readyOpen: string[] = [];
    const notReadyOpen = ['discord', 'linear'];
    const animating = new Set(['discord']);

    const newReadyOpen = collapseTransitioningItems(readyOpen, animating);
    const newNotReadyOpen = collapseTransitioningItems(notReadyOpen, animating);

    expect(newReadyOpen).toEqual([]); // discord arrives collapsed in ready group
    expect(newNotReadyOpen).toEqual(['linear']); // discord removed from not-ready
  });
});

// ─── Integration: full transition lifecycle ──────────────────────────────────

describe('full transition lifecycle', () => {
  test('plugin moves from ready to not-ready: grouping + animation + collapse', () => {
    // Initial state: slack is ready and expanded
    const initial = [plugin('slack', 'ready'), plugin('github', 'closed')];
    const snap1 = buildStateSnapshot(initial);
    const group1 = groupPlugins(initial);

    expect(group1.ready.map(p => p.name)).toEqual(['slack']);
    expect(group1.notReady.map(p => p.name)).toEqual(['github']);

    // Slack's tab is closed
    const updated = [plugin('slack', 'closed'), plugin('github', 'closed')];
    const changed = detectGroupChanges(snap1, updated);
    expect(changed).toEqual(new Set(['slack']));

    // Slack immediately moves to the not-ready group
    const group2 = groupPlugins(updated);
    expect(group2.ready).toEqual([]);
    expect(group2.notReady.map(p => p.name)).toEqual(['slack', 'github']);

    // Slack gets a fade-in animation class at its new position
    expect(getTransitionClass('slack', false, changed)).toBe('animate-group-fade-in-dim');
    expect(getTransitionClass('github', false, changed)).toBeUndefined();

    // Slack's expanded state is collapsed
    const readyOpen = collapseTransitioningItems(['slack'], changed);
    expect(readyOpen).toEqual([]); // removed from ready accordion
  });

  test('plugin moves from not-ready to ready: grouping + animation + collapse', () => {
    // Initial state: discord is not-ready and expanded
    const initial = [plugin('slack', 'ready'), plugin('discord', 'closed')];
    const snap1 = buildStateSnapshot(initial);

    // Discord becomes ready (user opens and logs into Discord tab)
    const updated = [plugin('slack', 'ready'), plugin('discord', 'ready')];
    const changed = detectGroupChanges(snap1, updated);
    expect(changed).toEqual(new Set(['discord']));

    // Discord immediately moves to the ready group
    const group2 = groupPlugins(updated);
    expect(group2.ready.map(p => p.name)).toEqual(['slack', 'discord']);
    expect(group2.notReady).toEqual([]);

    // Discord gets a fade-in animation class
    expect(getTransitionClass('discord', true, changed)).toBe('animate-group-fade-in');

    // Discord's expanded state is collapsed in the not-ready accordion
    const notReadyOpen = collapseTransitioningItems(['discord'], changed);
    expect(notReadyOpen).toEqual([]);
  });

  test('two plugins swap groups simultaneously', () => {
    const initial = [plugin('slack', 'ready'), plugin('discord', 'closed')];
    const snap1 = buildStateSnapshot(initial);

    // Slack becomes not-ready, Discord becomes ready — simultaneous
    const updated = [plugin('slack', 'closed'), plugin('discord', 'ready')];
    const changed = detectGroupChanges(snap1, updated);
    expect(changed).toEqual(new Set(['slack', 'discord']));

    const group2 = groupPlugins(updated);
    expect(group2.ready.map(p => p.name)).toEqual(['discord']);
    expect(group2.notReady.map(p => p.name)).toEqual(['slack']);

    // Each gets the correct animation for their target group
    expect(getTransitionClass('slack', false, changed)).toBe('animate-group-fade-in-dim');
    expect(getTransitionClass('discord', true, changed)).toBe('animate-group-fade-in');

    // Both are collapsed from their old accordions
    const readyOpen = collapseTransitioningItems(['slack'], changed);
    const notReadyOpen = collapseTransitioningItems(['discord'], changed);
    expect(readyOpen).toEqual([]);
    expect(notReadyOpen).toEqual([]);
  });

  test('rapid toggle: ready → closed → ready across two updates', () => {
    const initial = [plugin('slack', 'ready')];
    const snap1 = buildStateSnapshot(initial);

    // Step 1: slack becomes closed
    const step1 = [plugin('slack', 'closed')];
    const changed1 = detectGroupChanges(snap1, step1);
    expect(changed1).toEqual(new Set(['slack']));

    const snap2 = buildStateSnapshot(step1);

    // Step 2: slack becomes ready again (before animation finished)
    const step2 = [plugin('slack', 'ready')];
    const changed2 = detectGroupChanges(snap2, step2);
    expect(changed2).toEqual(new Set(['slack']));

    // After step 2, slack is back in the ready group
    const group = groupPlugins(step2);
    expect(group.ready.map(p => p.name)).toEqual(['slack']);
    expect(group.notReady).toEqual([]);

    // Gets the ready fade-in animation
    expect(getTransitionClass('slack', true, changed2)).toBe('animate-group-fade-in');
  });

  test('animation class is undefined when animating set is cleared', () => {
    const animating = new Set(['slack']);
    expect(getTransitionClass('slack', true, animating)).toBe('animate-group-fade-in');

    // After FADE_IN_MS, the timer clears the set
    const cleared = new Set<string>();
    expect(getTransitionClass('slack', true, cleared)).toBeUndefined();
  });

  test('non-transitioning plugins are unaffected by another plugin transitioning', () => {
    const initial = [plugin('slack', 'ready'), plugin('github', 'ready'), plugin('discord', 'closed')];
    const snap1 = buildStateSnapshot(initial);

    // Only slack transitions
    const updated = [plugin('slack', 'closed'), plugin('github', 'ready'), plugin('discord', 'closed')];
    const changed = detectGroupChanges(snap1, updated);
    expect(changed).toEqual(new Set(['slack']));

    // github and discord are unaffected
    expect(getTransitionClass('github', true, changed)).toBeUndefined();
    expect(getTransitionClass('discord', false, changed)).toBeUndefined();

    // github stays expanded if it was expanded
    const readyOpen = collapseTransitioningItems(['slack', 'github'], changed);
    expect(readyOpen).toEqual(['github']); // only slack removed
  });

  test('newly added plugin does not trigger animation', () => {
    const initial = [plugin('slack', 'ready')];
    const snap1 = buildStateSnapshot(initial);

    // New plugin appears (server discovers it)
    const updated = [plugin('slack', 'ready'), plugin('new-plugin', 'ready')];
    const changed = detectGroupChanges(snap1, updated);
    expect(changed).toEqual(new Set()); // no transition

    expect(getTransitionClass('new-plugin', true, changed)).toBeUndefined();
  });

  test('removed plugin does not crash or trigger animation', () => {
    const initial = [plugin('slack', 'ready'), plugin('removed', 'closed')];
    const snap1 = buildStateSnapshot(initial);

    // Plugin is removed (user uninstalls it)
    const updated = [plugin('slack', 'ready')];
    const changed = detectGroupChanges(snap1, updated);
    expect(changed).toEqual(new Set());
  });
});
