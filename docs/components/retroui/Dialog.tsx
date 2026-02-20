'use client';

import { cn } from '@/lib/utils';
import * as ReactDialog from '@radix-ui/react-dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';
import type { VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode, Ref } from 'react';

const Dialog = ReactDialog.Root;
const DialogTrigger = ReactDialog.Trigger;

const overlayVariants = cva(
  ` fixed bg-foreground/80 font-head
    data-[state=open]:fade-in-0
    data-[state=open]:animate-in
    data-[state=closed]:animate-out
    data-[state=closed]:fade-out-0
  `,
  {
    variants: {
      variant: {
        default: 'inset-0 z-50 bg-foreground/85',
        none: 'fixed bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type IDialogBackgroupProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof overlayVariants>;

const DialogBackdrop = ({
  ref,
  variant = 'default',
  className,
  ...props
}: IDialogBackgroupProps & { ref?: Ref<HTMLDivElement> }) => (
  <ReactDialog.Overlay className={cn(overlayVariants({ variant }), className)} ref={ref} {...props} />
);

const dialogVariants = cva(
  `fixed left-[50%] top-[50%] z-50 grid rounded overflow-hidden w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border-2 bg-background shadow-lg duration-200
  data-[state=open]:animate-in
  data-[state=open]:fade-in-0
  data-[state=open]:zoom-in-95
  data-[state=closed]:animate-out
  data-[state=closed]:fade-out-0
  data-[state=closed]:zoom-out-95`,
  {
    variants: {
      size: {
        auto: 'max-w-fit',
        sm: 'lg:max-w-[30%]',
        md: 'lg:max-w-[40%]',
        lg: 'lg:max-w-[50%]',
        xl: 'lg:max-w-[60%]',
        '2xl': 'lg:max-w-[70%]',
        '3xl': 'lg:max-w-[80%]',
        '4xl': 'lg:max-w-[90%]',
        screen: 'max-w-[100%]',
      },
    },
    defaultVariants: {
      size: 'auto',
    },
  },
);

interface IDialogContentProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof dialogVariants> {
  overlay?: IDialogBackgroupProps;
}

const DialogContent = ({
  ref,
  children,
  size = 'auto',
  className,
  overlay,
  ...props
}: IDialogContentProps & { ref?: Ref<HTMLDivElement> }) => (
  <ReactDialog.Portal>
    <DialogBackdrop {...overlay} />
    <ReactDialog.Content className={cn(dialogVariants({ size }), className)} ref={ref} {...props}>
      <VisuallyHidden>
        <ReactDialog.Title />
      </VisuallyHidden>
      <div className="relative flex flex-col">{children}</div>
    </ReactDialog.Content>
  </ReactDialog.Portal>
);

type IDialogDescriptionProps = HTMLAttributes<HTMLDivElement>;

const DialogDescription = ({ children, className, ...props }: IDialogDescriptionProps) => (
  <ReactDialog.Description className={cn(className)} {...props}>
    {children}
  </ReactDialog.Description>
);

const dialogFooterVariants = cva('flex items-center justify-end border-t-2 min-h-12 gap-4 px-4 py-2', {
  variants: {
    variant: {
      default: 'bg-background text-foreground',
    },
    position: {
      fixed: 'sticky bottom-0',
      static: 'static',
    },
  },
  defaultVariants: {
    position: 'fixed',
  },
});

type IDialogFooterProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof dialogFooterVariants>;

const DialogFooter = ({ children, className, position, variant, ...props }: IDialogFooterProps) => (
  <div className={cn(dialogFooterVariants({ position, variant }), className)} {...props}>
    {children}
  </div>
);

const dialogHeaderVariants = cva('flex items-center justify-between border-b-2 px-4 min-h-12', {
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground',
    },
    position: {
      fixed: 'sticky top-0',
      static: 'static',
    },
  },
  defaultVariants: {
    variant: 'default',
    position: 'static',
  },
});

const DialogHeaderDefaultLayout = ({ children }: { children: ReactNode }) => (
  <>
    {children}
    <DialogTrigger title="Close pop-up" className="cursor-pointer" asChild>
      <X />
    </DialogTrigger>
  </>
);

type IDialogHeaderProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof dialogHeaderVariants> &
  ReactDialog.DialogTitleProps;

const DialogHeader = ({ children, className, position, variant, asChild, ...props }: IDialogHeaderProps) => (
  <div className={cn(dialogHeaderVariants({ position, variant }), className)} {...props}>
    {asChild ? children : <DialogHeaderDefaultLayout>{children}</DialogHeaderDefaultLayout>}
  </div>
);

const DialogComponent = Object.assign(Dialog, {
  Trigger: DialogTrigger,
  Header: DialogHeader,
  Content: DialogContent,
  Description: DialogDescription,
  Footer: DialogFooter,
});

export { DialogComponent as Dialog };
export type { IDialogFooterProps };
