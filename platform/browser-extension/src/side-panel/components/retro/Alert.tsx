import { Text } from './Text';
import { cn } from '../../lib/cn';
import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { HtmlHTMLAttributes } from 'react';

const alertVariants = cva('relative w-full rounded border-2 p-4', {
  variants: {
    variant: {
      default: 'bg-background text-foreground [&_svg]:shrink-0',
      solid: 'bg-foreground text-background',
    },
    status: {
      error: 'bg-destructive/20 text-destructive border-destructive',
      success: 'bg-success/20 text-success border-success',
      warning: 'bg-accent text-accent-foreground border-accent-foreground',
      info: 'bg-muted text-muted-foreground border-muted-foreground',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

interface IAlertProps extends HtmlHTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {}

const Alert = ({ className, variant, status, ...props }: IAlertProps) => (
  <div role="alert" className={cn(alertVariants({ variant, status }), className)} {...props} />
);
Alert.displayName = 'Alert';

type IAlertTitleProps = HtmlHTMLAttributes<HTMLHeadingElement>;
const AlertTitle = ({ className, ...props }: IAlertTitleProps) => <Text as="h5" className={cn(className)} {...props} />;
AlertTitle.displayName = 'AlertTitle';

type IAlertDescriptionProps = HtmlHTMLAttributes<HTMLParagraphElement>;
const AlertDescription = ({ className, ...props }: IAlertDescriptionProps) => (
  <div className={cn('text-muted-foreground', className)} {...props} />
);

AlertDescription.displayName = 'AlertDescription';

const AlertComponent = Object.assign(Alert, {
  Title: AlertTitle,
  Description: AlertDescription,
});

export { AlertComponent as Alert };
