import type { ReactNode } from 'react';

export const RetroSteps = ({ children }: { children: ReactNode }) => (
  <div className="retro-steps border-border my-6 ml-2 border-l-2 pl-7 md:ml-4 md:pl-10">{children}</div>
);

export const RetroStep = ({ children }: { children: ReactNode }) => (
  <div className="retro-step relative mb-8 last:mb-0">{children}</div>
);
