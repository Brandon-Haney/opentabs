import { cn } from '@/lib/utils';
import type { TableOfContents as TOCType } from '@/lib/toc';
import type { ReactElement } from 'react';

interface TableOfContentsProps {
  toc: TOCType;
}

interface TOCItem {
  title: string;
  url: string;
  items?: TOCItem[];
}

const renderTOCItems = (items: TOCItem[], level = 0): ReactElement | null => {
  if (items.length === 0) return null;

  return (
    <ul className={cn('space-y-1', level > 0 && 'mt-1 ml-4')}>
      {items.map((item, index) => (
        <li key={index}>
          <a
            href={item.url}
            className="hover:text-foreground hover:border-accent block border-l-2 border-transparent py-1 pl-2 text-sm transition-colors">
            {item.title}
          </a>
          {item.items && renderTOCItems(item.items, level + 1)}
        </li>
      ))}
    </ul>
  );
};

export default function TableOfContents({ toc }: TableOfContentsProps) {
  if (!toc.items || toc.items.length === 0) {
    return null;
  }

  return (
    <div className="border-border rounded-(--radius) border-2 p-4">
      <h3 className="border-border mb-3 border-b-2 pb-2">On this Page</h3>
      {renderTOCItems(toc.items as TOCItem[])}
    </div>
  );
}
