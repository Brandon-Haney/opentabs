import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { GlobalHeader } from '@/components/global-header';
import { RetroSearchToggleLg } from '@/components/retro-search-toggle';

export const baseOptions: BaseLayoutProps = {
  nav: {
    /* Suppress the sidebar title — the GlobalHeader owns the logo on all pages. */
    title: () => null,
    component: <GlobalHeader />,
  },
  searchToggle: {
    components: {
      lg: <RetroSearchToggleLg hideIfDisabled />,
    },
  },
  /* Disable the default theme switch — GlobalHeader renders its own RetroThemeToggle. */
  themeSwitch: {
    enabled: false,
  },
};
