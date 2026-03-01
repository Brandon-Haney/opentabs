import { cn } from '../../lib/cn';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import type { ComponentProps } from 'react';

const Accordion = AccordionPrimitive.Root;

const AccordionItem = ({ className, ref, ...props }: ComponentProps<typeof AccordionPrimitive.Item>) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn(
      'bg-background text-foreground overflow-hidden rounded border-2 shadow-md transition-all hover:shadow-sm data-[state=open]:shadow-sm',
      className,
    )}
    {...props}
  />
);

const AccordionContent = ({
  className,
  children,
  ref,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Content>) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up bg-card text-card-foreground overflow-hidden font-sans"
    {...props}>
    <div className={cn(className)}>{children}</div>
  </AccordionPrimitive.Content>
);

const AccordionComponent = Object.assign(Accordion, {
  Item: AccordionItem,
  Content: AccordionContent,
});

export { AccordionComponent as Accordion };
