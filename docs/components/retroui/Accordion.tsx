'use client';

import { cn } from '@/lib/utils';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import type * as React from 'react';

const Accordion = AccordionPrimitive.Root;

const AccordionItem = ({
  ref,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item> & {
  ref?: React.Ref<React.ComponentRef<typeof AccordionPrimitive.Item>>;
}) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn(
      'bg-background text-foreground border-border overflow-hidden border-2 shadow-md transition-all hover:shadow-sm data-[state=open]:shadow-sm',
      className,
    )}
    {...props}
  />
);

const AccordionHeader = ({
  ref,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> & {
  ref?: React.Ref<React.ComponentRef<typeof AccordionPrimitive.Trigger>>;
}) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        'font-head flex flex-1 cursor-pointer items-start justify-between px-4 py-2 focus:outline-hidden [&[data-state=open]>svg]:rotate-180',
        className,
      )}
      {...props}>
      {children}
      <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
);

const AccordionContent = ({
  ref,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof AccordionPrimitive.Content>>;
}) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up bg-background text-foreground overflow-hidden font-sans"
    {...props}>
    <div className={cn('px-4 pt-2 pb-4', className)}>{children}</div>
  </AccordionPrimitive.Content>
);

const AccordionComponent = Object.assign(Accordion, {
  Item: AccordionItem,
  Header: AccordionHeader,
  Content: AccordionContent,
});

export { AccordionComponent as Accordion };
