import { useState } from 'react';
import { Button } from './retro/Button.js';
import { Dialog } from './retro/Dialog.js';

type ConfirmationData = {
  id: string;
  tool: string;
  plugin: string;
  params: Record<string, unknown>;
};

interface ConfirmationDialogProps {
  confirmations: ConfirmationData[];
  onRespond: (id: string, decision: 'allow' | 'deny', alwaysAllow?: boolean) => void;
}

/**
 * Clamps a tracked index to valid bounds after the list shrinks.
 * When the item at `currentIndex` is removed, the index stays the same,
 * pointing to the next item that slid into its position. If the removed
 * item was the last one, the index clamps down to the new last position.
 */
const resolveDisplayIndex = (currentIndex: number, count: number): number => Math.min(currentIndex, count - 1);

const ConfirmationDialog = ({ confirmations, onRespond }: ConfirmationDialogProps) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [alwaysAllow, setAlwaysAllow] = useState(false);

  const count = confirmations.length;
  const safeIndex = resolveDisplayIndex(currentIndex, count);
  const current = confirmations[safeIndex];

  const handleAllow = () => {
    if (!current) return;
    onRespond(current.id, 'allow', alwaysAllow || undefined);
    setAlwaysAllow(false);
  };

  const handleDeny = () => {
    if (!current) return;
    onRespond(current.id, 'deny');
    setAlwaysAllow(false);
  };

  return (
    <Dialog
      open={count > 0}
      onOpenChange={open => {
        if (!open) handleDeny();
      }}>
      <Dialog.Content onInteractOutside={e => e.preventDefault()} onEscapeKeyDown={e => e.preventDefault()}>
        <Dialog.Header>
          <span className="font-head text-sm">Approve Tool</span>
          {count > 1 && (
            <span className="font-mono text-xs">
              {safeIndex + 1} of {count}
            </span>
          )}
        </Dialog.Header>
        <Dialog.Body className="space-y-2">
          {current && (
            <>
              <div>
                <span className="text-muted-foreground text-xs">Tool</span>
                <div className="font-mono text-sm">{current.tool}</div>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Plugin</span>
                <div className="font-sans text-sm">{current.plugin}</div>
              </div>
              {current.params && Object.keys(current.params).length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs">Parameters</summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded border border-border bg-card px-2 py-1 font-mono text-xs leading-tight">
                    {JSON.stringify(current.params, null, 2)}
                  </pre>
                </details>
              )}
              <label className="mt-3 flex items-center gap-2">
                <input type="checkbox" checked={alwaysAllow} onChange={e => setAlwaysAllow(e.target.checked)} />
                <span className="text-sm">Always allow this tool</span>
              </label>
              <span className="text-muted-foreground text-xs">Sets permission to Auto</span>
            </>
          )}
        </Dialog.Body>
        <Dialog.Footer>
          {count > 1 && (
            <>
              <button
                type="button"
                className="mr-auto cursor-pointer font-mono text-muted-foreground text-xs hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={safeIndex === 0}
                onClick={() => setCurrentIndex(i => i - 1)}>
                prev
              </button>
              <button
                type="button"
                className="mr-2 cursor-pointer font-mono text-muted-foreground text-xs hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={safeIndex >= count - 1}
                onClick={() => setCurrentIndex(i => i + 1)}>
                next
              </button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={handleDeny}>
            Deny
          </Button>
          <Button size="sm" onClick={handleAllow}>
            Allow
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
};

export { ConfirmationDialog, resolveDisplayIndex };
export type { ConfirmationData };
