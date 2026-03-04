import type { TabState } from '@opentabs-dev/shared';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import type { FailedPluginState, PluginState } from '../bridge.js';
import { matchesTool } from '../bridge.js';
import { FailedPluginCard } from './FailedPluginCard.js';
import { PluginCard } from './PluginCard.js';
import { Accordion } from './retro/Accordion.js';

/** Duration for fade-out at old position (ms) */
const FADE_OUT_MS = 150;
/** Duration for fade-in at new position (ms) */
const FADE_IN_MS = 200;

type TransitionPhase = 'fading-out' | 'fading-in';

/**
 * Track plugins transitioning between ready and not-ready groups.
 * Returns a map of plugin name → current transition phase, plus CSS class helpers.
 */
function useGroupTransitions(plugins: PluginState[], isFiltering: boolean) {
  const prevStates = useRef<Map<string, TabState>>(new Map());
  const [transitioning, setTransitioning] = useState<Map<string, TransitionPhase>>(new Map());

  // Detect plugins that changed groups
  useEffect(() => {
    if (isFiltering) {
      prevStates.current = new Map(plugins.map(p => [p.name, p.tabState]));
      return;
    }

    const newTransitions = new Map<string, TransitionPhase>();

    for (const plugin of plugins) {
      const prev = prevStates.current.get(plugin.name);
      if (prev === undefined) continue;

      const wasReady = prev === 'ready';
      const isReady = plugin.tabState === 'ready';

      if (wasReady !== isReady) {
        newTransitions.set(plugin.name, 'fading-out');
      }
    }

    // Update stored states
    prevStates.current = new Map(plugins.map(p => [p.name, p.tabState]));

    if (newTransitions.size === 0) return;

    // Start fade-out phase
    setTransitioning(prev => {
      const next = new Map(prev);
      for (const [name, phase] of newTransitions) {
        next.set(name, phase);
      }
      return next;
    });

    let fadeInTimer: ReturnType<typeof setTimeout> | undefined;

    // After fade-out, switch to fade-in phase
    const fadeOutTimer = setTimeout(() => {
      setTransitioning(prev => {
        const next = new Map<string, TransitionPhase>();
        for (const [name, phase] of prev) {
          if (newTransitions.has(name) && phase === 'fading-out') {
            next.set(name, 'fading-in');
          } else {
            next.set(name, phase);
          }
        }
        return next;
      });

      // After fade-in, clear transitions
      fadeInTimer = setTimeout(() => {
        setTransitioning(prev => {
          const next = new Map(prev);
          for (const name of newTransitions.keys()) {
            next.delete(name);
          }
          return next.size === 0 ? new Map() : next;
        });
      }, FADE_IN_MS);
    }, FADE_OUT_MS);

    return () => {
      clearTimeout(fadeOutTimer);
      clearTimeout(fadeInTimer);
    };
  }, [plugins, isFiltering]);

  const getTransitionClass = useCallback(
    (pluginName: string, isReady: boolean): string | undefined => {
      const phase = transitioning.get(pluginName);
      if (!phase) return undefined;
      if (phase === 'fading-out') return 'opacity-0 transition-opacity duration-150';
      // Fade-in: use different animation depending on target group opacity
      return isReady ? 'animate-group-fade-in' : 'animate-group-fade-in-dim';
    },
    [transitioning],
  );

  return { transitioning, getTransitionClass };
}

const PluginList = ({
  plugins,
  failedPlugins,
  activeTools,
  setPlugins,
  toolFilter,
  onUpdate,
  onRemove,
  removingPlugins,
  pluginErrors,
  skipPermissions,
}: {
  plugins: PluginState[];
  failedPlugins: FailedPluginState[];
  activeTools: Set<string>;
  setPlugins: Dispatch<SetStateAction<PluginState[]>>;
  toolFilter: string;
  onUpdate?: (pluginName: string) => void;
  onRemove?: (pluginName: string) => void;
  removingPlugins?: Set<string>;
  pluginErrors?: Map<string, string>;
  skipPermissions?: boolean;
}) => {
  const filterLower = toolFilter.toLowerCase();

  const visiblePlugins = filterLower
    ? plugins.filter(p => (p.tools ?? []).some(t => matchesTool(t, filterLower)))
    : plugins;

  // Hide failed plugins when filtering tools
  const visibleFailed = filterLower ? [] : failedPlugins;

  const { transitioning, getTransitionClass } = useGroupTransitions(plugins, !!filterLower);

  // Track whether the not-ready section was previously visible for label animation
  const prevHadNotReady = useRef(false);
  const [labelVisible, setLabelVisible] = useState(false);
  const [labelMounted, setLabelMounted] = useState(false);

  // Group plugins, accounting for fade-out: during fade-out a plugin stays in its old group
  const readyPlugins: PluginState[] = [];
  const notReadyPlugins: PluginState[] = [];

  if (!filterLower) {
    for (const plugin of visiblePlugins) {
      const phase = transitioning.get(plugin.name);
      if (phase === 'fading-out') {
        // During fade-out, keep in OLD group (opposite of current state)
        if (plugin.tabState === 'ready') {
          // Now ready → was not-ready → keep in not-ready during fade-out
          notReadyPlugins.push(plugin);
        } else {
          // Now not-ready → was ready → keep in ready during fade-out
          readyPlugins.push(plugin);
        }
      } else {
        // Normal or fading-in: use current state
        if (plugin.tabState === 'ready') {
          readyPlugins.push(plugin);
        } else {
          notReadyPlugins.push(plugin);
        }
      }
    }
  }

  const hasNotReady = notReadyPlugins.length > 0;

  // Manage label mount/visibility for smooth fade in/out
  useEffect(() => {
    let unmountTimer: ReturnType<typeof setTimeout> | undefined;

    if (filterLower) {
      setLabelMounted(false);
      setLabelVisible(false);
      prevHadNotReady.current = false;
    } else if (hasNotReady && !prevHadNotReady.current) {
      // Not-ready section appearing — mount label, then make visible next frame
      setLabelMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setLabelVisible(true);
        });
      });
      prevHadNotReady.current = hasNotReady;
    } else if (!hasNotReady && prevHadNotReady.current) {
      // Not-ready section disappearing — start fade out, then unmount
      setLabelVisible(false);
      unmountTimer = setTimeout(() => setLabelMounted(false), FADE_IN_MS);
      prevHadNotReady.current = hasNotReady;
    } else if (hasNotReady) {
      // Already visible — ensure state is correct
      setLabelMounted(true);
      setLabelVisible(true);
      prevHadNotReady.current = hasNotReady;
    }

    return () => clearTimeout(unmountTimer);
  }, [hasNotReady, filterLower]);

  if (filterLower && visiblePlugins.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">No tools matching &ldquo;{toolFilter}&rdquo;</div>
    );
  }

  const renderCard = (plugin: PluginState, isReadyGroup: boolean) => (
    <PluginCard
      key={plugin.name}
      plugin={plugin}
      activeTools={activeTools}
      setPlugins={setPlugins}
      toolFilter={toolFilter}
      onUpdate={onUpdate ? () => onUpdate(plugin.name) : undefined}
      onRemove={onRemove ? () => onRemove(plugin.name) : undefined}
      removingPlugin={removingPlugins?.has(plugin.name)}
      actionError={pluginErrors?.get(plugin.name) ?? null}
      skipPermissions={skipPermissions}
      transitionClass={getTransitionClass(plugin.name, isReadyGroup)}
    />
  );

  return (
    <>
      {visibleFailed.length > 0 && (
        <div className="mb-3 space-y-2">
          {visibleFailed.map(fp => (
            <FailedPluginCard key={fp.specifier} plugin={fp} />
          ))}
        </div>
      )}
      {filterLower ? (
        <Accordion type="multiple" className="space-y-2">
          {visiblePlugins.map(p => renderCard(p, true))}
        </Accordion>
      ) : (
        <>
          {readyPlugins.length > 0 && (
            <Accordion type="multiple" className="space-y-2">
              {readyPlugins.map(p => renderCard(p, true))}
            </Accordion>
          )}
          {labelMounted && (
            <div
              className={`px-3 pt-3 pb-1 font-mono text-[10px] text-muted-foreground uppercase tracking-widest transition-opacity duration-200 ${labelVisible ? 'opacity-100' : 'opacity-0'}`}>
              NOT CONNECTED
            </div>
          )}
          {notReadyPlugins.length > 0 && (
            <Accordion type="multiple" className="space-y-2">
              {notReadyPlugins.map(p => renderCard(p, false))}
            </Accordion>
          )}
        </>
      )}
    </>
  );
};

export { PluginList };
