'use client';

import { useState } from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { File as FileIcon, Folder as FolderIcon, FolderOpen, ChevronRight } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const RetroFiles = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('not-prose border-border bg-card border-2 p-2 ps-3 shadow-md', className)} {...props} />
);

interface RetroFileProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  icon?: ReactNode;
}

export const RetroFile = ({
  name,
  icon = <FileIcon className="size-4 shrink-0" />,
  className,
  ...props
}: RetroFileProps) => (
  <div
    className={cn(
      'hover:bg-accent hover:text-accent-foreground flex cursor-default flex-row items-center gap-2 px-2 py-1.5 font-sans text-sm transition-colors',
      className,
    )}
    {...props}>
    <span className="text-muted-foreground">{icon}</span>
    {name}
  </div>
);

interface RetroFolderProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  defaultOpen?: boolean;
  disabled?: boolean;
}

export const RetroFolder = ({
  name,
  defaultOpen = false,
  disabled,
  className: _className,
  children,
  ...props
}: RetroFolderProps) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <CollapsiblePrimitive.Root open={open} onOpenChange={disabled ? undefined : setOpen} {...props}>
      <CollapsiblePrimitive.Trigger
        disabled={disabled}
        className={cn(
          'font-head hover:bg-accent flex w-full flex-row items-center gap-2 px-2 py-1.5 text-sm font-semibold transition-colors',
          disabled && 'cursor-default opacity-50',
        )}>
        <span className="text-primary">
          {open ? <FolderOpen className="size-4 shrink-0" /> : <FolderIcon className="size-4 shrink-0" />}
        </span>
        {name}
        <ChevronRight
          className={cn(
            'text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content>
        <div className="border-border ms-2 flex flex-col border-l-2 ps-2">{children}</div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
};
