'use client';

import Link from 'next/link';
import { Menu } from 'lucide-react';
import { SidebarTrigger } from 'fumadocs-ui/components/sidebar/base';
import { RetroThemeToggle } from '@/components/retro-theme-toggle';

interface GlobalHeaderProps {
  /** Render the mobile sidebar hamburger trigger (docs pages only). */
  showSidebarTrigger?: boolean;
}

export function GlobalHeader({ showSidebarTrigger }: GlobalHeaderProps) {
  return (
    <header
      id="nd-global-header"
      className="border-border bg-background sticky top-0 z-40 flex h-14 items-center gap-2 border-b-2 px-4">
      <Link href="/" className="font-head mr-auto inline-flex items-center gap-2 text-xl">
        <img src="/icon.svg" alt="" width={32} height={32} className="size-8" />
        OpenTabs
      </Link>
      <RetroThemeToggle />
      {showSidebarTrigger && (
        <SidebarTrigger
          aria-label="Toggle sidebar"
          className="border-border bg-background flex items-center justify-center border-2 p-2 shadow-sm transition-all hover:translate-y-0.5 hover:shadow-none md:hidden">
          <Menu className="size-4" />
        </SidebarTrigger>
      )}
    </header>
  );
}
