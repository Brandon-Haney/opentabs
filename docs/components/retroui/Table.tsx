import { cn } from '@/lib/utils';
import type * as React from 'react';

const Table = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLTableElement> & { ref?: React.Ref<HTMLTableElement> }) => (
  <div className="relative h-full w-full overflow-auto">
    <table ref={ref} className={cn('w-full caption-bottom border-2 text-sm shadow-lg', className)} {...props} />
  </div>
);

const TableHeader = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement> & { ref?: React.Ref<HTMLTableSectionElement> }) => (
  <thead
    ref={ref}
    className={cn('bg-primary text-primary-foreground font-head [&_tr]:border-b-2', className)}
    {...props}
  />
);

const TableBody = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement> & { ref?: React.Ref<HTMLTableSectionElement> }) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
);

const TableFooter = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement> & { ref?: React.Ref<HTMLTableSectionElement> }) => (
  <tfoot
    ref={ref}
    className={cn('bg-accent text-accent-foreground border-t-2 font-medium [&>tr]:last:border-b-0', className)}
    {...props}
  />
);

const TableRow = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { ref?: React.Ref<HTMLTableRowElement> }) => (
  <tr
    ref={ref}
    className={cn(
      'hover:bg-accent hover:text-accent-foreground data-[state=selected]:bg-muted border-b-2 transition-colors',
      className,
    )}
    {...props}
  />
);

const TableHead = ({
  className,
  ref,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { ref?: React.Ref<HTMLTableCellElement> }) => (
  <th
    ref={ref}
    className={cn(
      'text-primary-foreground h-10 px-4 text-left align-middle font-medium md:h-12 [&:has([role=checkbox])]:pr-0',
      className,
    )}
    {...props}
  />
);

const TableCell = ({
  className,
  ref,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { ref?: React.Ref<HTMLTableCellElement> }) => (
  <td ref={ref} className={cn('p-2 align-middle md:p-3 [&:has([role=checkbox])]:pr-0', className)} {...props} />
);

const TableCaption = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLTableCaptionElement> & { ref?: React.Ref<HTMLTableCaptionElement> }) => (
  <caption ref={ref} className={cn('text-muted-foreground my-2 text-sm', className)} {...props} />
);

const TableObj = Object.assign(Table, {
  Header: TableHeader,
  Body: TableBody,
  Footer: TableFooter,
  Row: TableRow,
  Head: TableHead,
  Cell: TableCell,
  Caption: TableCaption,
});

export { TableObj as Table };
