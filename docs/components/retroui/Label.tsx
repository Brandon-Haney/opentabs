import { cn } from '@/lib/utils';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva } from 'class-variance-authority';
import type * as React from 'react';

const labelVariants = cva('leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70');

export const Label = ({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) => (
  <LabelPrimitive.Root className={cn(labelVariants(), className)} {...props} />
);
