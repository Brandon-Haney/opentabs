'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { Dialog } from '@/components/retroui/Dialog';
import { type DialogProps } from '@radix-ui/react-dialog';
import { Command as CommandPrimitive } from 'cmdk';
import { Check, LucideIcon, Search } from 'lucide-react';

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        'bg-background text-foreground border-border flex h-full w-full flex-col overflow-hidden shadow-md',
        className,
      )}
      {...props}
    />
  );
}

type CommandDialogProps = DialogProps & { className?: string };

const CommandDialog = ({ children, className, ...props }: CommandDialogProps) => {
  return (
    <Dialog {...props}>
      <Dialog.Content className={cn('w-full max-w-md overflow-hidden p-0 shadow-lg', className)}>
        <Command className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          {children}
        </Command>
      </Dialog.Content>
    </Dialog>
  );
};

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="border-border flex items-center border-b-2 px-3" cmdk-input-wrapper="" data-slot="command-input">
      <Search className="text-foreground me-2 h-4 w-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        className={cn(
          'text-foreground placeholder:text-muted-foreground flex h-11 w-full bg-transparent py-3 font-sans text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'bg-background h-[calc(min(300px,var(--cmdk-list-height)))] max-h-[400px] overflow-auto overscroll-contain transition-[height]',
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="text-muted-foreground py-6 text-center font-sans text-sm"
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1.5 font-sans [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator data-slot="command-separator" className={cn('bg-border h-px', className)} {...props} />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'text-foreground data-[selected=true]:bg-primary data-[selected=true]:text-primary-foreground hover:bg-accent hover:text-accent-foreground relative flex cursor-pointer items-center gap-2 px-2 py-1.5 font-sans text-sm outline-hidden transition-all select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

const CommandShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('text-muted-foreground ms-auto font-sans text-xs tracking-widest', className)}
      {...props}
    />
  );
};

interface CommandCheckProps {
  icon?: LucideIcon;
  className?: string;
}

function CommandCheck({ icon: Icon = Check, className, ...props }: CommandCheckProps) {
  return (
    <Icon
      data-slot="command-check"
      data-check="true"
      className={cn('text-primary ms-auto size-4', className)}
      {...props}
    />
  );
}

const CommandComponent = Object.assign(Command, {
  Check: CommandCheck,
  Dialog: CommandDialog,
  Empty: CommandEmpty,
  Group: CommandGroup,
  Input: CommandInput,
  Item: CommandItem,
  List: CommandList,
  Separator: CommandSeparator,
  Shortcut: CommandShortcut,
});

export { CommandComponent as Command };
