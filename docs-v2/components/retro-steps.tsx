import type { ReactNode } from 'react';

export const RetroSteps = ({ children }: { children: ReactNode }) => (
  <div className="retro-steps border-border my-6 ml-4 border-l-2 pl-10">{children}</div>
);

export const RetroStep = ({ children }: { children: ReactNode }) => (
  <div className="retro-step relative mb-8 last:mb-0">{children}</div>
);
