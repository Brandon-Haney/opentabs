import { cn } from '@/lib/utils';
import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  variant?: 'primary' | 'outline' | 'link';
}

const sizeClasses = {
  sm: 'p-2',
  md: 'p-3',
  lg: 'p-4',
} as const;

const variantClasses = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  outline: 'bg-transparent text-foreground',
  link: 'bg-transparent text-primary hover:underline border-0 shadow-none',
} as const;

const IconButton = ({ children, size = 'md', className, variant = 'primary', ...props }: ButtonProps) => (
  <button
    className={cn(
      'font-head border-border border-2 shadow-md transition-all hover:shadow-xs',
      sizeClasses[size],
      variantClasses[variant],
      className,
    )}
    {...props}>
    {children}
  </button>
);

export { IconButton };
