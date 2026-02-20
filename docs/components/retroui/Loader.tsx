import { cn } from '@/lib/utils';
import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type * as React from 'react';

const loaderVariants = cva('flex gap-1', {
  variants: {
    variant: {
      default: '[&>div]:bg-primary [&>div]:border-border',
      secondary: '[&>div]:bg-secondary [&>div]:border-border',
      outline: '[&>div]:bg-transparent [&>div]:border-border',
    },
    size: {
      sm: '[&>div]:w-2 [&>div]:h-2',
      md: '[&>div]:w-3 [&>div]:h-3',
      lg: '[&>div]:w-4 [&>div]:h-4',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'md',
  },
});

interface LoaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'>, VariantProps<typeof loaderVariants> {
  asChild?: boolean;
  count?: number;
  duration?: number;
  delayStep?: number;
}

const Loader = ({
  ref,
  className,
  variant,
  size,
  count = 3,
  duration = 0.5,
  delayStep = 100,
  ...props
}: LoaderProps & { ref?: React.Ref<HTMLDivElement> }) => (
  <div
    className={cn(loaderVariants({ variant, size }), className)}
    ref={ref}
    role="status"
    aria-label="Loading..."
    {...props}>
    {Array.from({ length: count }).map((_, i) => (
      <div
        key={i}
        className="animate-bounce border-2"
        style={{
          animationDuration: `${duration}s`,
          animationIterationCount: 'infinite',
          animationDelay: `${i * delayStep}ms`,
        }}
      />
    ))}
  </div>
);

export { Loader };
