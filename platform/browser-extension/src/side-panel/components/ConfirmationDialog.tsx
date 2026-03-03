import { ChevronDown, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { COUNTDOWN_POLL_INTERVAL_MS } from '../constants.js';
import { Button } from './retro/Button.js';
import { Menu } from './retro/Menu.js';
import { Progress } from './retro/Progress.js';
import { Text } from './retro/Text.js';

type ConfirmationData = {
  id: string;
  tool: string;
  domain: string | null;
  tabId?: number;
  paramsPreview: string;
  timeoutMs: number;
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
      const newRemaining = Math.max(0, timeoutMs - elapsed);
      setRemaining(newRemaining);
      if (newRemaining === 0) clearInterval(id);
    };
    const id = setInterval(update, COUNTDOWN_POLL_INTERVAL_MS);
    update();
    return () => clearInterval(id);
  }, [timeoutMs, receivedAt]);

  const seconds = Math.ceil(remaining / 1000);
  const fraction = remaining / timeoutMs;

  return (
    <div className="mt-2 flex items-center gap-2">
      <Progress
        value={fraction * 100}
        className="flex-1"
        indicatorClassName={fraction > 0.33 ? 'bg-accent-foreground' : 'bg-destructive'}
      />
      <span className="font-mono text-muted-foreground text-xs tabular-nums">{seconds}s</span>
    </div>
  );
};

/** Renders the "Allow Always" button with a scope dropdown */
const AllowAlwaysButton = ({ domain, onSelect }: { domain: string | null; onSelect: (scope: Scope) => void }) => (
  <Menu>
    <Menu.Trigger asChild>
      <Button size="sm" variant="outline" className="w-full gap-1 text-xs">
        Allow Always
        <ChevronDown className="h-3 w-3" />
      </Button>
    </Menu.Trigger>
    <Menu.Content side="top" align="end">
      {domain && <Menu.Item onSelect={() => onSelect('tool_domain')}>For this tool on this domain</Menu.Item>}
      <Menu.Item onSelect={() => onSelect('tool_all')}>For this tool everywhere</Menu.Item>
      {domain && <Menu.Item onSelect={() => onSelect('domain_all')}>For all tools on {domain}</Menu.Item>}
    </Menu.Content>
  </Menu>
);

/**
 * Clamps a tracked index to valid bounds after the list shrinks.
 * When the item at `currentIndex` is removed, the index stays the same,
 * pointing to the next item that slid into its position. If the removed
 * item was the last one, the index clamps down to the new last position.
 */
const resolveDisplayIndex = (currentIndex: number, count: number): number => Math.min(currentIndex, count - 1);

const ConfirmationDialog = ({ confirmations, onRespond, onDenyAll }: ConfirmationDialogProps) => {
  const [currentIndex, setCurrentIndex] = useState(0);

  const safeIndex = resolveDisplayIndex(currentIndex, confirmations.length);
  const current = confirmations[safeIndex];
  if (!current) return null;

  const count = confirmations.length;

  return (
    <div className="mx-4 mt-2" role="alert">
      <div className="rounded border-2 border-accent-foreground bg-accent/30 shadow-md">
        {/* Header */}
        <div className="flex items-center gap-2 border-accent-foreground border-b-2 px-3 py-2">
          <ShieldAlert className="h-4 w-4 shrink-0 text-accent-foreground" />
          <Text as="h6" className="flex-1 text-sm">
            Approval Required
          </Text>
          {count > 1 && (
            <span className="font-mono text-muted-foreground text-xs">
              {safeIndex + 1} of {count}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="space-y-2 px-3 py-2">
          {/* Tool name */}
          <div>
            <span className="font-sans text-muted-foreground text-xs">Tool</span>
            <div className="font-mono text-sm">{current.tool}</div>
          </div>

          {/* Domain */}
          {current.domain && (
            <div>
              <span className="font-sans text-muted-foreground text-xs">Domain</span>
              <div className="font-sans text-sm">{current.domain}</div>
            </div>
          )}

          {/* Params preview */}
          {current.paramsPreview && (
            <div>
              <span className="font-sans text-muted-foreground text-xs">Parameters</span>
              <pre className="mt-0.5 max-h-20 overflow-auto rounded border border-border bg-card px-2 py-1 font-mono text-xs leading-tight">
                {current.paramsPreview}
              </pre>
            </div>
          )}

          {/* Countdown */}
          <CountdownBar timeoutMs={current.timeoutMs} receivedAt={current.receivedAt} />
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1.5 border-accent-foreground border-t-2 py-2 pr-4 pl-3">
          <Button size="sm" className="w-full" onClick={() => onRespond(current.id, 'allow_once')}>
            Allow Once
          </Button>
          <AllowAlwaysButton domain={current.domain} onSelect={scope => onRespond(current.id, 'allow_always', scope)} />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="w-full text-destructive text-xs"
              onClick={() => onRespond(current.id, 'deny')}>
              Deny
            </Button>
            {count > 1 && (
              <Button size="sm" variant="outline" className="w-full text-destructive text-xs" onClick={onDenyAll}>
                Deny All
              </Button>
            )}
          </div>
        </div>

        {/* Navigation for multiple confirmations */}
        {count > 1 && (
          <div className="flex justify-center gap-2 border-border border-t px-3 py-1">
            <button
              type="button"
              className="cursor-pointer font-mono text-muted-foreground text-xs hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeIndex === 0}
              onClick={() => setCurrentIndex(i => i - 1)}>
              prev
            </button>
            <button
              type="button"
              className="cursor-pointer font-mono text-muted-foreground text-xs hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeIndex >= count - 1}
              onClick={() => setCurrentIndex(i => i + 1)}>
              next
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export { ConfirmationDialog, resolveDisplayIndex };
export type { ConfirmationData };
