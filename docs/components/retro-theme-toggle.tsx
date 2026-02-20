'use client';

import { cn } from '@/lib/utils';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';

interface Props {
  className?: string;
}

// Hydration-safe mounted check using useSyncExternalStore
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export const RetroThemeToggle = ({ className }: Props) => {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const isDark = mounted ? resolvedTheme === 'dark' : false;

  return (
    <button
      type="button"
      aria-label="Toggle Theme"
      data-theme-toggle=""
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={cn(
        'border-border bg-background flex items-center justify-center border-2 p-2 shadow-sm transition-all hover:translate-y-0.5 hover:shadow-none',
        className,
      )}>
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
};
