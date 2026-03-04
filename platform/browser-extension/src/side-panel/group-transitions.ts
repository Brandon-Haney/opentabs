/**
 * Pure logic for plugin readiness grouping and transition animations.
 *
 * Extracted from PluginList so it can be tested without React rendering.
 * The React hook in PluginList drives this state machine with timers.
 */

import type { TabState } from '@opentabs-dev/shared';

/** Duration for fade-in animation at the new position (ms) */
const FADE_IN_MS = 200;

// ─── Grouping ────────────────────────────────────────────────────────────────

interface GroupablePlugin {
  readonly name: string;
  readonly tabState: TabState;
}

interface GroupResult<T extends GroupablePlugin> {
  readonly ready: T[];
  readonly notReady: T[];
}

/**
 * Split plugins into ready and not-ready groups.
 * A plugin is "ready" only when tabState === 'ready'.
 * Both 'unavailable' and 'closed' are not-ready.
 */
function groupPlugins<T extends GroupablePlugin>(plugins: readonly T[]): GroupResult<T> {
  const ready: T[] = [];
  const notReady: T[] = [];
  for (const p of plugins) {
    if (p.tabState === 'ready') {
      ready.push(p);
    } else {
      notReady.push(p);
    }
  }
  return { ready, notReady };
}

// ─── Change detection ────────────────────────────────────────────────────────

/**
 * Detect which plugins changed readiness group between two snapshots.
 * Returns the set of plugin names that crossed the ready/not-ready boundary.
 *
 * A plugin that was not present in the previous snapshot is treated as new
 * (no transition). A plugin that disappeared is ignored.
 */
function detectGroupChanges(prev: ReadonlyMap<string, TabState>, current: readonly GroupablePlugin[]): Set<string> {
  const changed = new Set<string>();
  for (const plugin of current) {
    const prevState = prev.get(plugin.name);
    if (prevState === undefined) continue; // new plugin — no transition
    const wasReady = prevState === 'ready';
    const isReady = plugin.tabState === 'ready';
    if (wasReady !== isReady) {
      changed.add(plugin.name);
    }
  }
  return changed;
}

/**
 * Build a snapshot map of plugin name → tabState for change detection.
 */
function buildStateSnapshot(plugins: readonly GroupablePlugin[]): Map<string, TabState> {
  return new Map(plugins.map(p => [p.name, p.tabState]));
}

// ─── Animation classes ───────────────────────────────────────────────────────

/**
 * Resolve the CSS class for a plugin that is currently animating.
 * Returns undefined if the plugin is not animating.
 *
 * - Ready group target: full opacity fade-in
 * - Not-ready group target: reduced opacity (0.7) fade-in
 */
function getTransitionClass(
  pluginName: string,
  isReadyGroup: boolean,
  animating: ReadonlySet<string>,
): string | undefined {
  if (!animating.has(pluginName)) return undefined;
  return isReadyGroup ? 'animate-group-fade-in' : 'animate-group-fade-in-dim';
}

// ─── Accordion open state ────────────────────────────────────────────────────

/**
 * Remove transitioning plugins from an accordion's open list.
 * When a plugin changes groups, its expanded state must be reset
 * so it arrives collapsed at its new position.
 *
 * Returns the original array (same reference) if nothing was removed,
 * or a new filtered array if any items were removed.
 */
function collapseTransitioningItems(openItems: readonly string[], animating: ReadonlySet<string>): string[] {
  if (animating.size === 0) return openItems as string[];
  const filtered = openItems.filter(name => !animating.has(name));
  return filtered.length === openItems.length ? (openItems as string[]) : filtered;
}

export {
  FADE_IN_MS,
  buildStateSnapshot,
  collapseTransitioningItems,
  detectGroupChanges,
  getTransitionClass,
  groupPlugins,
};
export type { GroupResult, GroupablePlugin };
