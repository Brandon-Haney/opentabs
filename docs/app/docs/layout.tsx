import { GlobalHeader } from '@/components/global-header';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions}
      nav={{
        ...baseOptions.nav,
        component: <GlobalHeader showSidebarTrigger />,
      }}
      containerProps={{
        style: {
          gridTemplate: `"header header header header header"
            "sidebar sidebar toc-popover toc toc"
            "sidebar sidebar main toc toc" 1fr / minmax(min-content, 1fr) var(--fd-sidebar-col) minmax(0, calc(var(--fd-layout-width, 97rem) - var(--fd-sidebar-width) - var(--fd-toc-width))) var(--fd-toc-width) minmax(min-content, 1fr)`,
        },
      }}>
      {children}
    </DocsLayout>
  );
}
