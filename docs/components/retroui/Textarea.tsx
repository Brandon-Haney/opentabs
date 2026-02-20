import { cn } from '@/lib/utils';

const Textarea = ({ placeholder = 'Enter text...', className = '', ...props }) => (
  <textarea
    placeholder={placeholder}
    rows={4}
    className={cn(
      'border-border placeholder:text-muted-foreground w-full rounded border-2 px-4 py-2 shadow-md transition focus:shadow-xs focus:outline-hidden',
      className,
    )}
    {...props}
  />
);

export { Textarea };
