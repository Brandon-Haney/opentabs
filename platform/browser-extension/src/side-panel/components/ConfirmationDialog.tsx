import { Button } from './retro/Button.js';
import { Text } from './retro/Text.js';
import { cn } from '../lib/cn.js';
import { ShieldAlert, ChevronDown } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import type { SpConfirmationRequestMessage } from '../../extension-messages.js';

type ConfirmationData = SpConfirmationRequestMessage['data'] & {
  /** Timestamp when the confirmation was received in the side panel */
  receivedAt: number;
};

type Decision = 'allow_once' | 'allow_always' | 'deny';
type Scope = 'tool_domain' | 'tool_all' | 'domain_all';

interface ConfirmationDialogProps {
  confirmations: ConfirmationData[];
  onRespond: (id: string, decision: Decision, scope?: Scope) => void;
  onDenyAll: () => void;
}

/** Renders a countdown bar and seconds remaining based on the confirmation timeout */
const CountdownBar = ({ timeoutMs, receivedAt }: { timeoutMs: number; receivedAt: number }) => {
  const [remaining, setRemaining] = useState(timeoutMs);

  useEffect(() => {
    const update = () => {
      const elapsed = Date.now() - receivedAt;
      setRemaining(Math.max(0, timeoutMs - elapsed));
    };
    update();
    const id = setInterval(update, 200);
    return () => clearInterval(id);
  }, [timeoutMs, receivedAt]);

  const seconds = Math.ceil(remaining / 1000);
  const fraction = remaining / timeoutMs;

  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="bg-muted border-border h-1.5 flex-1 overflow-hidden rounded border">
        <div
          className={cn(
            'h-full transition-all duration-200',
            fraction > 0.33 ? 'bg-accent-foreground' : 'bg-destructive',
          )}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <span className="text-muted-foreground font-mono text-xs tabular-nums">{seconds}s</span>
    </div>
  );
};

/** Renders the "Allow Always" button with a scope dropdown */
const AllowAlwaysButton = ({ domain, onSelect }: { domain: string | null; onSelect: (scope: Scope) => void }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => setOpen(v => !v)}>
        Allow Always
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div className="border-border bg-card absolute right-0 bottom-full z-50 mb-1 w-56 rounded border-2 shadow-md">
          <button
            type="button"
            className="hover:bg-accent w-full cursor-pointer px-3 py-2 text-left font-sans text-xs"
            onClick={() => {
              onSelect('tool_domain');
              setOpen(false);
            }}>
            For this tool on this domain
          </button>
          <button
            type="button"
            className="hover:bg-accent w-full cursor-pointer px-3 py-2 text-left font-sans text-xs"
            onClick={() => {
              onSelect('tool_all');
              setOpen(false);
            }}>
            For this tool everywhere
          </button>
          {domain && (
            <button
              type="button"
              className="hover:bg-accent w-full cursor-pointer px-3 py-2 text-left font-sans text-xs"
              onClick={() => {
                onSelect('domain_all');
                setOpen(false);
              }}>
              For all tools on {domain}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const ConfirmationDialog = ({ confirmations, onRespond, onDenyAll }: ConfirmationDialogProps) => {
  const [currentIndex, setCurrentIndex] = useState(0);

  // Clamp index when confirmations are removed (derived, no effect needed)
  const safeIndex = Math.min(currentIndex, Math.max(0, confirmations.length - 1));
  const current = confirmations[safeIndex];
  if (!current) return null;

  const count = confirmations.length;

  return (
    <div className="mx-3 mt-2" role="alert">
      <div className="border-accent-foreground bg-accent/30 rounded border-2 shadow-md">
        {/* Header */}
        <div className="border-accent-foreground flex items-center gap-2 border-b-2 px-3 py-2">
          <ShieldAlert className="text-accent-foreground h-4 w-4 shrink-0" />
          <Text as="h6" className="flex-1 text-sm">
            Approval Required
          </Text>
          {count > 1 && (
            <span className="text-muted-foreground font-mono text-xs">
              {safeIndex + 1} of {count}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="space-y-2 px-3 py-2">
          {/* Tool name */}
          <div>
            <span className="text-muted-foreground font-sans text-xs">Tool</span>
            <div className="font-mono text-sm">{current.tool}</div>
          </div>

          {/* Domain */}
          {current.domain && (
            <div>
              <span className="text-muted-foreground font-sans text-xs">Domain</span>
              <div className="font-sans text-sm">{current.domain}</div>
            </div>
          )}

          {/* Params preview */}
          {current.paramsPreview && (
            <div>
              <span className="text-muted-foreground font-sans text-xs">Parameters</span>
              <pre className="border-border bg-card mt-0.5 max-h-20 overflow-auto rounded border px-2 py-1 font-mono text-xs leading-tight">
                {current.paramsPreview}
              </pre>
            </div>
          )}

          {/* Countdown */}
          <CountdownBar timeoutMs={current.timeoutMs} receivedAt={current.receivedAt} />
        </div>

        {/* Actions */}
        <div className="border-accent-foreground flex flex-wrap items-center gap-2 border-t-2 px-3 py-2">
          <Button size="sm" onClick={() => onRespond(current.id, 'allow_once')}>
            Allow Once
          </Button>
          <AllowAlwaysButton domain={current.domain} onSelect={scope => onRespond(current.id, 'allow_always', scope)} />
          <Button
            size="sm"
            variant="outline"
            className="text-destructive text-xs"
            onClick={() => onRespond(current.id, 'deny')}>
            Deny
          </Button>
          {count > 1 && (
            <Button size="sm" variant="outline" className="text-destructive ml-auto text-xs" onClick={onDenyAll}>
              Deny All
            </Button>
          )}
        </div>

        {/* Navigation for multiple confirmations */}
        {count > 1 && (
          <div className="border-border flex justify-center gap-2 border-t px-3 py-1">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-xs disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeIndex === 0}
              onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}>
              prev
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-xs disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeIndex >= count - 1}
              onClick={() => setCurrentIndex(i => Math.min(count - 1, i + 1))}>
              next
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export { ConfirmationDialog };
export type { ConfirmationData };
