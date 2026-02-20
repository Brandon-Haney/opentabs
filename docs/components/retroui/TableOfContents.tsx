'use client';

import { cn } from '@/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type React from 'react';

interface TOCItem {
  title: string;
  url: string;
  level: number;
  items?: TOCItem[];
}

interface ManualTOCItem {
  id: string;
  title: string;
  depth: number;
}

interface TableOfContentsProps {
  depth?: number;
  className?: string;
  children?: React.ReactNode;
  data?: ManualTOCItem[];
}

const generateTOCFromDOM = (depth: number = 6): TOCItem[] => {
  const headings: NodeListOf<HTMLHeadingElement> = document.querySelectorAll(
    Array.from({ length: depth }, (_, i) => `h${i + 1}`).join(', '),
  );

  const items: TOCItem[] = [];
  const stack: TOCItem[] = [];

  headings.forEach(heading => {
    const level = parseInt(heading.tagName.charAt(1));
    const id =
      heading.id ||
      heading.textContent
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]/g, '') ||
      '';

    if (!heading.id && id) {
      heading.id = id;
    }

    const item: TOCItem = {
      title: heading.textContent || '',
      url: `#${id}`,
      level,
    };

    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent) {
      if (!parent.items) parent.items = [];
      parent.items.push(item);
    } else {
      items.push(item);
    }

    stack.push(item);
  });

  return items;
};

const convertManualDataToTOC = (data: ManualTOCItem[]): TOCItem[] => {
  const items: TOCItem[] = [];
  const stack: TOCItem[] = [];

  data.forEach(item => {
    const tocItem: TOCItem = {
      title: item.title,
      url: `#${item.id}`,
      level: item.depth,
    };

    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= item.depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent) {
      if (!parent.items) parent.items = [];
      parent.items.push(tocItem);
    } else {
      items.push(tocItem);
    }

    stack.push(tocItem);
  });

  return items;
};

const renderTOCItems = (items: TOCItem[], level = 0, activeId: string | null) => {
  if (items.length === 0) return null;

  return (
    <ul className={`space-y-1 ${level > 0 ? 'mt-1 ml-4' : ''}`}>
      {items.map((item, index) => {
        const isActive = activeId === item.url.substring(1);
        return (
          <li key={index}>
            <a
              href={item.url}
              className={`block max-w-full truncate border-l-2 py-1 pl-2 text-sm transition-colors ${
                isActive
                  ? 'text-accent-foreground border-border bg-accent'
                  : 'hover:border-border hover:text-foreground border-transparent'
              }`}>
              {item.title}
            </a>
            {item.items && renderTOCItems(item.items, level + 1, activeId)}
          </li>
        );
      })}
    </ul>
  );
};

const emptyTOC: TOCItem[] = [];

const useDOMTocItems = (depth: number, enabled: boolean): TOCItem[] => {
  const itemsRef = useRef<TOCItem[]>(emptyTOC);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};

      itemsRef.current = generateTOCFromDOM(depth);

      const observer = new MutationObserver(() => {
        itemsRef.current = generateTOCFromDOM(depth);
        onStoreChange();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['id'],
      });

      return () => observer.disconnect();
    },
    [depth, enabled],
  );

  const getSnapshot = useCallback(() => itemsRef.current, []);
  const getServerSnapshot = useCallback(() => emptyTOC, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
};

const subscribeNoop = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

const TableOfContents = ({ depth = 2, className = '', children, data }: TableOfContentsProps) => {
  const isMounted = useSyncExternalStore(subscribeNoop, getClientSnapshot, getServerSnapshot);

  const dataItems = useMemo(() => (data ? convertManualDataToTOC(data) : emptyTOC), [data]);

  const domItems = useDOMTocItems(depth, isMounted && !data);

  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      { rootMargin: '-20% 0% -35% 0%' },
    );

    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach(heading => observer.observe(heading));

    return () => observer.disconnect();
  }, []);

  const tocItems = data ? dataItems : domItems;

  if (tocItems.length === 0) {
    return null;
  }

  return (
    <div className={cn('sidebar-scroll h-60 w-52 overflow-y-auto rounded border-2 p-4 shadow-md', className)}>
      {children}
      {renderTOCItems(tocItems, 0, activeId)}
    </div>
  );
};

export { TableOfContents };
