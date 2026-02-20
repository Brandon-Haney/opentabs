'use client';

import { cn } from '@/lib/utils';
import * as RadixTabs from '@radix-ui/react-tabs';
import { createContext, useContext, useEffect, useId, useMemo, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';

// Context for collection index tracking — same pattern as Fumadocs internal tabs
interface RetroTabsContextType {
  items?: string[];
  collection: string[];
}

const RetroTabsContext = createContext<RetroTabsContextType | null>(null);

const useTabContext = (): RetroTabsContextType => {
  const ctx = useContext(RetroTabsContext);
  if (!ctx) throw new Error('Must be rendered inside <Tabs>');
  return ctx;
};

// Track registration order of Tab children so Tab can resolve its value from index
const useCollectionIndex = (): number => {
  const key = useId();
  const { collection } = useTabContext();
  useEffect(
    () => () => {
      const idx = collection.indexOf(key);
      if (idx !== -1) collection.splice(idx, 1);
    },
    [key, collection],
  );
  if (!collection.includes(key)) collection.push(key);
  return collection.indexOf(key);
};

// Escape whitespace in tab values (same as Fumadocs)
const escapeValue = (v: string): string => v.toLowerCase().replace(/\s/g, '-');

// ── RetroTabs (root) ────────────────────────────────────────────────────────

interface RetroTabsProps extends Omit<ComponentProps<typeof RadixTabs.Root>, 'value' | 'onValueChange'> {
  /** Tab labels — each item becomes a trigger button */
  items?: string[];
  /** Shortcut for defaultValue when items is provided (0-based index) */
  defaultIndex?: number;
  /** Optional label displayed before the trigger list */
  label?: ReactNode;
}

const RetroTabs = ({
  className,
  items,
  label,
  defaultIndex = 0,
  defaultValue = items?.[defaultIndex] ? escapeValue(items[defaultIndex]) : undefined,
  children,
  ...props
}: RetroTabsProps) => {
  const [value, setValue] = useState(defaultValue);
  const collection = useMemo<string[]>(() => [], []);

  return (
    <RadixTabs.Root
      className={cn('my-6', className)}
      value={value}
      onValueChange={v => {
        // In items mode, only accept values that came from the items list
        if (items && !items.some(item => escapeValue(item) === v)) return;
        setValue(v);
      }}
      {...props}>
      {items && (
        <RadixTabs.List className="not-prose border-border flex flex-row space-x-2 border-b-2 pb-0">
          {label && <span className="my-auto me-auto text-sm font-medium">{label}</span>}
          {items.map(item => (
            <RadixTabs.Trigger
              key={item}
              value={escapeValue(item)}
              className={cn(
                'border-b-border -mb-[2px] cursor-pointer border-2 border-transparent px-4 py-1 font-sans text-sm transition-all focus:outline-none',
                'data-[state=active]:border-border data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:font-semibold',
              )}>
              {item}
            </RadixTabs.Trigger>
          ))}
        </RadixTabs.List>
      )}
      <RetroTabsContext.Provider value={useMemo(() => ({ items, collection }), [collection, items])}>
        {children}
      </RetroTabsContext.Provider>
    </RadixTabs.Root>
  );
};

// ── RetroTab (content panel) ────────────────────────────────────────────────

interface RetroTabProps extends Omit<ComponentProps<typeof RadixTabs.Content>, 'value'> {
  /** Tab value — resolved from index in items mode if omitted */
  value?: string;
}

const RetroTab = ({ value, className, ...props }: RetroTabProps) => {
  const { items } = useTabContext();
  const index = useCollectionIndex();
  const resolved = value ?? items?.at(index);
  if (!resolved) throw new Error('Failed to resolve Tab value — pass a value prop or use items on the parent Tabs');

  return (
    <RadixTabs.Content
      value={escapeValue(resolved)}
      forceMount
      className={cn('border-border mt-0 w-full border-2 p-4 font-sans data-[state=inactive]:hidden', className)}
      {...props}
    />
  );
};

export { RetroTabs, RetroTab };
export type { RetroTabsProps, RetroTabProps };
