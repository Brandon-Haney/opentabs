import * as AccordionPrimitive from '@radix-ui/react-accordion';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

const Accordion = AccordionPrimitive.Root;

const AccordionItem = ({ className, ref, ...props }: ComponentProps<typeof AccordionPrimitive.Item>) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn(
      'overflow-hidden rounded border-2 bg-background text-foreground shadow-md transition-all hover:shadow-sm data-[state=open]:shadow-sm',
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
  <AccordionPrimitive.Content ref={ref} className="overflow-hidden bg-card font-sans text-card-foreground" {...props}>
    <div className={cn(className)}>{children}</div>
  </AccordionPrimitive.Content>
);

const AccordionComponent = Object.assign(Accordion, {
  Item: AccordionItem,
  Content: AccordionContent,
});

export { AccordionComponent as Accordion };
