'use client';
import SearchDialog from '@/components/search';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

export const Provider = ({ children }: { children: ReactNode }) => (
  <RootProvider
    search={{
      SearchDialog,
    }}>
    {children}
  </RootProvider>
);
