'use client';

import { cn } from '@/lib/utils';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import type * as React from 'react';

const Progress = ({
  ref,
  className,
  value,
  ...props
}: React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
  ref?: React.Ref<React.ComponentRef<typeof ProgressPrimitive.Root>>;
}) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('bg-background relative h-4 w-full overflow-hidden border-2', className)}
    {...props}>
    <ProgressPrimitive.Indicator
      className="bg-primary h-full w-full flex-1 transition-all"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
);

export { Progress };
