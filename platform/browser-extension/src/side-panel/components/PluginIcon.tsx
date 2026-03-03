import type { TabState } from '@opentabs-dev/shared';
import { ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { sanitizeSvg } from '../../sanitize-svg.js';
import { cn } from '../lib/cn.js';

const AVATAR_PALETTE_SIZE = 10;

/** djb2 string hash to unsigned 32-bit integer. */
const hashString = (str: string): number => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
};

/** Returns a CSS variable reference for the deterministic avatar color. */
const getAvatarVar = (pluginName: string): string =>
  `var(--avatar-${String(hashString(pluginName) % AVATAR_PALETTE_SIZE)})`;

/** Extracts the display letter from the plugin's displayName, falling back to name. */
const getAvatarLetter = (displayName: string, pluginName: string): string =>
  (displayName[0] ?? pluginName[0] ?? '?').toUpperCase();

interface PluginIconProps {
  pluginName: string;
  displayName: string;
  tabState?: TabState;
  hasUpdate?: boolean;
  size?: number;
  className?: string;
  iconSvg?: string;
  iconInactiveSvg?: string;
  active?: boolean;
}

/**
 * Priority-based status indicator positioned at the bottom-right of the icon.
 * Priority: closed = nothing, unavailable = yellow dot, ready+update = ArrowUp icon, ready = green dot.
 * When active is true and state is ready (no update), the dot flashes with HDD-style activity animation.
 * When active transitions to false, the dot soft-fades out over 500ms.
 */
const StatusIndicator = ({
  tabState,
  hasUpdate,
  size,
  active = false,
}: {
  tabState: TabState;
  hasUpdate: boolean;
  size: number;
  active?: boolean;
}) => {
  const prevActiveRef = useRef(false);
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!wasActive || active) return;
    const startTimer = setTimeout(() => setFadingOut(true), 0);
    const endTimer = setTimeout(() => setFadingOut(false), 500);
    return () => {
      clearTimeout(startTimer);
      clearTimeout(endTimer);
    };
  }, [active]);

  if (tabState === 'closed') return null;

  const dotSize = Math.max(8, Math.round(size * 0.3));

  if (tabState === 'unavailable') {
    return (
      <div
        className="absolute rounded-full border-2 border-card bg-primary"
        style={{ width: dotSize, height: dotSize, bottom: -2, right: -2 }}
      />
    );
  }

  if (hasUpdate) {
    const iconSize = Math.max(6, Math.round(dotSize * 0.6));
    return (
      <div
        className="absolute flex items-center justify-center rounded-full border-2 border-card bg-accent"
        style={{ width: dotSize, height: dotSize, bottom: -2, right: -2 }}>
        <ArrowUp className="text-accent-foreground" style={{ width: iconSize, height: iconSize }} strokeWidth={3} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'absolute rounded-full border-2 border-card bg-success',
        active && 'animate-activity-flash',
        fadingOut && !active && 'animate-activity-fade-out',
      )}
      style={{ width: dotSize, height: dotSize, bottom: -2, right: -2 }}
    />
  );
};

/**
 * Sanitizes rawSvg for rendering, returning undefined and logging a warning if sanitizeSvg throws.
 * Exported for unit testing.
 */
const tryGetSanitizedSvg = (rawSvg: string | undefined, pluginName: string): string | undefined => {
  if (!rawSvg) return undefined;
  try {
    return sanitizeSvg(rawSvg);
  } catch (err) {
    console.warn(`[opentabs] sanitizeSvg failed for plugin "${pluginName}":`, err);
    return undefined;
  }
};

const PluginIcon = ({
  pluginName,
  displayName,
  tabState = 'closed',
  hasUpdate = false,
  size = 32,
  className = '',
  iconSvg,
  iconInactiveSvg,
  active = false,
}: PluginIconProps) => {
  const isReady = tabState === 'ready';
  const hasSvg = !!iconSvg;
  const rawSvg = isReady ? iconSvg : iconInactiveSvg;
  const svgToRender = tryGetSanitizedSvg(rawSvg, pluginName);
  const innerSize = Math.round(size * 0.6);

  if (hasSvg && svgToRender) {
    return (
      <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
        <div
          className="flex h-full w-full items-center justify-center rounded border-2 border-border"
          style={{ width: size, height: size }}>
          <div
            className="overflow-hidden"
            style={{ width: innerSize, height: innerSize }}
            dangerouslySetInnerHTML={{ __html: svgToRender }}
          />
        </div>
        <StatusIndicator tabState={tabState} hasUpdate={hasUpdate} size={size} active={active} />
      </div>
    );
  }

  const letter = getAvatarLetter(displayName, pluginName);
  const fontSize = Math.round(size * 0.55);

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center rounded border-2 border-border"
        style={{ width: size, height: size, backgroundColor: getAvatarVar(pluginName) }}>
        <span className="select-none font-head text-white leading-none" style={{ fontSize, letterSpacing: '-0.02em' }}>
          {letter}
        </span>
      </div>
      <StatusIndicator tabState={tabState} hasUpdate={hasUpdate} size={size} active={active} />
    </div>
  );
};

export { AVATAR_PALETTE_SIZE, getAvatarLetter, getAvatarVar, hashString, tryGetSanitizedSvg, PluginIcon };
