import { Ghost } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Text } from './Text';

interface IEmptyProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
}

const Empty = ({ className, ...props }: IEmptyProps) => (
  <div
    className={cn(
      'flex flex-col items-center justify-center rounded border-2 bg-card p-4 text-center shadow-md transition-all hover:shadow-none md:p-8',
      className,
    )}
    {...props}
  />
);
Empty.displayName = 'Empty';

const EmptyContent = ({ className, ...props }: IEmptyProps) => (
  <div className={cn('flex flex-col items-center gap-3', className)} {...props} />
);
EmptyContent.displayName = 'Empty.Content';

const EmptyIcon = ({ children, className, ...props }: IEmptyProps) => (
  <div className={cn(className)} {...props}>
    {children || <Ghost className="h-full w-full" />}
  </div>
);
EmptyIcon.displayName = 'Empty.Icon';

const EmptyTitle = ({ className, ...props }: IEmptyProps) => (
  <Text as="h3" className={cn('font-bold text-lg md:text-2xl', className)} {...props} />
);
EmptyTitle.displayName = 'Empty.Title';

const EmptySeparator = ({ className, ...props }: IEmptyProps) => (
  <div role="separator" className={cn('h-1 w-16 bg-primary', className)} {...props} />
);
EmptySeparator.displayName = 'Empty.Separator';

const EmptyDescription = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('max-w-[320px] text-muted-foreground', className)} {...props} />
);
EmptyDescription.displayName = 'Empty.Description';

const EmptyComponent = Object.assign(Empty, {
  Content: EmptyContent,
  Icon: EmptyIcon,
  Title: EmptyTitle,
  Separator: EmptySeparator,
  Description: EmptyDescription,
});

export { EmptyComponent as Empty };
