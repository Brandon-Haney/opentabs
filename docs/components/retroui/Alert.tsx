import { HtmlHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { Text } from '@/components/retroui/Text';

const alertVariants = cva('relative w-full rounded border-2 p-4', {
  variants: {
    variant: {
      default: 'bg-background text-foreground [&_svg]:shrink-0',
      solid: 'bg-foreground text-background',
    },
    status: {
      error: 'bg-destructive text-destructive-foreground border-destructive',
      success: 'bg-success text-success-foreground border-success-border',
      warning: 'bg-warning text-warning-foreground border-warning-border',
      info: 'bg-info text-info-foreground border-info-border',
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

interface IAlertTitleProps extends HtmlHTMLAttributes<HTMLHeadingElement> {}
const AlertTitle = ({ className, ...props }: IAlertTitleProps) => <Text as="h5" className={cn(className)} {...props} />;
AlertTitle.displayName = 'AlertTitle';

interface IAlertDescriptionProps extends HtmlHTMLAttributes<HTMLParagraphElement> {}
const AlertDescription = ({ className, ...props }: IAlertDescriptionProps) => (
  <div className={cn('text-muted-foreground', className)} {...props} />
);

AlertDescription.displayName = 'AlertDescription';

const AlertComponent = Object.assign(Alert, {
  Title: AlertTitle,
  Description: AlertDescription,
});

export { AlertComponent as Alert };
