'use client';

import { cn } from '@/lib/utils';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ComponentPropsWithoutRef } from 'react';

const Menu = DropdownMenu.Root;
const Trigger = DropdownMenu.Trigger;

const Content = ({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) => (
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      className={cn('bg-card absolute top-2 min-w-20 border-2 shadow-md', className)}
      {...props}
    />
  </DropdownMenu.Portal>
);

const MenuItem = ({
  ref,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Item> & { ref?: React.Ref<HTMLDivElement> }) => (
  <DropdownMenu.Item
    ref={ref}
    className={cn(
      'hover:bg-primary focus:bg-primary text-foreground relative flex cursor-default items-center px-2 py-1.5 text-sm outline-hidden transition-colors select-none data-disabled:pointer-events-none data-disabled:opacity-50',
      className,
    )}
    {...props}
  />
);

const MenuComponent = Object.assign(Menu, {
  Trigger,
  Content,
  Item: MenuItem,
});

export { MenuComponent as Menu };
