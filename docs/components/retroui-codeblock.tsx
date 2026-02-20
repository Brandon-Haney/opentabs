'use client';

import { cn } from '@/lib/utils';
import { Pre } from 'fumadocs-ui/components/codeblock';
import { Check, Clipboard } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodeBlockProps } from 'fumadocs-ui/components/codeblock';
import type { CSSProperties, RefObject } from 'react';

const RetroCopyButton = ({
  containerRef,
  className,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  className?: string;
}) => {
  const [checked, setChecked] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  const onClick = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const pre = containerRef.current?.getElementsByTagName('pre').item(0);
    if (!pre) return;
    const clone = pre.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.nd-copy-ignore').forEach(node => {
      node.replaceWith('\n');
    });
    void navigator.clipboard.writeText(clone.textContent || '').then(() => {
      setChecked(true);
      timeoutRef.current = setTimeout(() => {
        setChecked(false);
      }, 1500);
    });
  }, [containerRef]);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  return (
    <button
      type="button"
      aria-label={checked ? 'Copied Text' : 'Copy Text'}
      onClick={onClick}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center rounded border-2 p-1.5 transition-all',
        'shadow-sm hover:shadow-none active:translate-x-0.5 active:translate-y-0.5',
        className,
      )}>
      {checked ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
    </button>
  );
};

const RetroCodeBlock = ({
  title,
  allowCopy = true,
  keepBackground = false,
  icon,
  viewportProps = {},
  children,
  className,
  // Actions is replaced by our own copy button rendering
  Actions: _Actions,
  'data-line-numbers': lineNumbers,
  'data-line-numbers-start': lineNumbersStart,
  ...props
}: CodeBlockProps) => {
  const areaRef = useRef<HTMLDivElement>(null);

  const viewportStyle: CSSProperties = {
    ...(lineNumbers ? { counterSet: `line ${(lineNumbersStart ?? 1) - 1}` } : {}),
    // Override shiki line padding — the viewport div handles padding uniformly on all sides.
    // Without title, add extra right padding for the floating copy button.
    ['--padding-left' as string]: '0',
    ['--padding-right' as string]: !title ? 'calc(var(--spacing) * 10)' : '0',
    ...viewportProps.style,
  };

  return (
    <figure
      dir="ltr"
      role="group"
      tabIndex={-1}
      data-line-numbers={lineNumbers}
      data-line-numbers-start={lineNumbersStart}
      {...props}
      className={cn(
        'shiki not-prose border-border relative my-6 overflow-hidden rounded border-2 text-sm shadow-md',
        keepBackground && 'bg-(--shiki-light-bg) dark:bg-(--shiki-dark-bg)',
        className,
      )}>
      {title ? (
        // Title bar — mirrors RetroUI Dialog.Header: bg-primary, border-b-2, px-4, min-h-10
        <div className="bg-primary font-head text-primary-foreground border-border flex min-h-10 items-center justify-between border-b-2 px-4">
          <div className="flex min-w-0 items-center gap-2">
            {typeof icon === 'string' ? (
              <div className="[&_svg]:size-3.5" dangerouslySetInnerHTML={{ __html: icon }} />
            ) : (
              icon
            )}
            <figcaption className="truncate text-sm">{title}</figcaption>
          </div>
          {allowCopy && (
            <RetroCopyButton
              containerRef={areaRef}
              className="border-primary-foreground/40 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20"
            />
          )}
        </div>
      ) : (
        allowCopy && (
          // Floating copy button when no title — top-right corner
          <div className="absolute top-3 right-3 z-10">
            <RetroCopyButton
              containerRef={areaRef}
              className="border-border bg-background text-muted-foreground hover:text-foreground"
            />
          </div>
        )
      )}
      <div
        ref={areaRef}
        {...viewportProps}
        role="region"
        aria-label="Code content"
        tabIndex={0}
        className={cn(
          'fd-scroll-container max-h-[400px] overflow-auto bg-(--shiki-light-bg) p-4 font-mono sm:max-h-[600px] dark:bg-(--shiki-dark-bg)',
          'focus-visible:ring-border focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
          viewportProps.className,
        )}
        style={viewportStyle}>
        {children}
      </div>
    </figure>
  );
};

// Re-export Pre so callers can use it alongside RetroCodeBlock
export { RetroCodeBlock, Pre };
