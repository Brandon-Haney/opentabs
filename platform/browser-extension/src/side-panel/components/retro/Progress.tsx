import * as ProgressPrimitives from '@radix-ui/react-progress';
import { cn } from '../../lib/cn';

interface IProgressProps extends ProgressPrimitives.ProgressProps {
  /** Classes applied to the indicator (the filled bar) */
  indicatorClassName?: string;
}

const Progress = ({ className, indicatorClassName, value, ...props }: IProgressProps) => (
  <ProgressPrimitives.Root
    className={cn('relative h-1.5 overflow-hidden rounded border border-border bg-muted', className)}
    value={value}
    {...props}>
    <ProgressPrimitives.Indicator
      className={cn('h-full bg-accent-foreground transition-all duration-200', indicatorClassName)}
      style={{ width: `${value ?? 0}%` }}
    />
  </ProgressPrimitives.Root>
);

export { Progress };
export type { IProgressProps };
