'use client';

import { cn } from '@/lib/utils';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

type AccordionRootProps = ComponentProps<typeof AccordionPrimitive.Root>;

const RetroAccordions = ({ className, ...props }: AccordionRootProps) => (
  <AccordionPrimitive.Root className={cn('my-6 flex flex-col gap-3', className)} {...props} />
);
RetroAccordions.displayName = 'RetroAccordions';

interface RetroAccordionProps extends Omit<ComponentProps<typeof AccordionPrimitive.Item>, 'value' | 'title'> {
  title: string | ReactNode;
  value?: string;
  id?: string;
}

const RetroAccordion = ({ className, title, id, value, children, ...props }: RetroAccordionProps) => {
  const resolvedValue = value ?? (typeof title === 'string' ? title : (id ?? 'item'));
  return (
    <AccordionPrimitive.Item
      className={cn(
        'bg-background text-foreground border-border overflow-hidden border-2 shadow-md transition-all hover:shadow-sm data-[state=open]:shadow-sm',
        className,
      )}
      value={resolvedValue}
      id={id}
      {...props}>
      <AccordionPrimitive.Header className="flex">
        <AccordionPrimitive.Trigger className="font-head flex flex-1 cursor-pointer items-start justify-between px-4 py-2 focus:outline-hidden [&[data-state=open]>svg]:rotate-180">
          {title}
          <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content className="text-foreground bg-background data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up overflow-hidden font-sans">
        <div className="px-4 pt-2 pb-4">{children}</div>
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  );
};
RetroAccordion.displayName = 'RetroAccordion';

export { RetroAccordions, RetroAccordion };
