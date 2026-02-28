'use client';

import { Button } from '@/components/retroui';
import { cn } from '@/lib/utils';
import * as React from 'react';

export const CodeBlock = ({ className, children, ...props }: React.HTMLAttributes<HTMLPreElement>) => {
  const [hasCopied, setHasCopied] = React.useState(false);
  const preRef = React.useRef<HTMLPreElement>(null);

  const handleClickCopy = () => {
    const code = preRef.current?.textContent;
    if (code) {
      setHasCopied(true);
      navigator.clipboard.writeText(code).catch(() => undefined);

      setTimeout(() => {
        setHasCopied(false);
      }, 3000);
    }
  };

  return (
    <div className="relative my-6">
      <pre className={cn('bg-code-bg text-code-fg overflow-x-auto rounded-(--radius) p-4', className)} {...props}>
        <Button disabled={hasCopied} className="absolute top-4 right-4 z-10" size="sm" onClick={handleClickCopy}>
          {hasCopied ? 'Copied' : 'Copy'}
        </Button>
        <span ref={preRef}>{children}</span>
      </pre>
    </div>
  );
};
