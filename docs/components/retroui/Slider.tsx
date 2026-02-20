'use client';

import { cn } from '@/lib/utils';
import * as SliderPrimitive from '@radix-ui/react-slider';
import type * as React from 'react';

const Slider = ({
  ref,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  ref?: React.Ref<React.ComponentRef<typeof SliderPrimitive.Root>>;
}) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none items-center select-none', className)}
    {...props}>
    <SliderPrimitive.Track className="bg-background relative h-3 w-full grow overflow-hidden border-2">
      <SliderPrimitive.Range className="bg-primary absolute h-full" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="bg-background focus-visible:ring-border block h-4.5 w-4.5 border-2 shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitive.Root>
);

export { Slider };
