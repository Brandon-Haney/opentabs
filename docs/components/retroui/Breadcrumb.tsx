import { cn } from '@/lib/utils';
import { Slot } from '@radix-ui/react-slot';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import type * as React from 'react';

const BreadcrumbRoot = ({
  ref,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'nav'> & { ref?: React.Ref<HTMLElement> }) => (
  <nav ref={ref} aria-label="breadcrumb" className={cn('w-full text-sm', className)} {...props} />
);

const BreadcrumbList = ({
  ref,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'ol'> & { ref?: React.Ref<HTMLOListElement> }) => (
  <ol
    ref={ref}
    className={cn('text-muted-foreground flex flex-wrap items-center gap-1.5 sm:gap-2.5', className)}
    {...props}
  />
);

const BreadcrumbItem = ({
  ref,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'li'> & { ref?: React.Ref<HTMLLIElement> }) => (
  <li ref={ref} className={cn('inline-flex items-center', className)} {...props} />
);

const BreadcrumbLink = ({
  ref,
  asChild,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'a'> & { asChild?: boolean; ref?: React.Ref<HTMLAnchorElement> }) => {
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      ref={ref}
      className={cn(
        'hover:text-foreground focus:ring-border rounded-sm font-medium transition-colors focus:ring-2 focus:outline-none',
        className,
      )}
      {...props}
    />
  );
};

const BreadcrumbPage = ({
  ref,
  className,
  ...props
}: React.ComponentPropsWithoutRef<'span'> & { ref?: React.Ref<HTMLSpanElement> }) => (
  <span ref={ref} aria-current="page" className={cn('text-foreground font-semibold', className)} {...props} />
);

const BreadcrumbSeparator = ({ children, className, ...props }: React.ComponentProps<'li'>) => (
  <li
    role="presentation"
    aria-hidden="true"
    className={cn('text-muted-foreground [&>svg]:h-4 [&>svg]:w-4', className)}
    {...props}>
    {children ?? <ChevronRight />}
  </li>
);

const BreadcrumbEllipsis = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span role="presentation" className={cn('flex h-9 w-9 items-center justify-center', className)} {...props}>
    <MoreHorizontal className="h-4 w-4" />
    <span className="sr-only">More</span>
  </span>
);

const Breadcrumb = Object.assign(BreadcrumbRoot, {
  List: BreadcrumbList,
  Item: BreadcrumbItem,
  Link: BreadcrumbLink,
  Page: BreadcrumbPage,
  Separator: BreadcrumbSeparator,
  Ellipsis: BreadcrumbEllipsis,
});

export { Breadcrumb };
