import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import type { FailedPluginState } from '../bridge.js';

const FailedPluginCard = ({ plugin }: { plugin: FailedPluginState }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded border-2 border-destructive/50 bg-destructive/10 p-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
        <span className="font-head text-destructive text-sm">Failed to load</span>
      </div>
      <div className="mt-1 truncate text-muted-foreground text-xs">{plugin.specifier}</div>
      <div className={`mt-1 select-text text-destructive/80 text-xs leading-snug ${expanded ? '' : 'line-clamp-2'}`}>
        {plugin.error}
      </div>
      {plugin.error.length > 100 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 cursor-pointer text-muted-foreground text-xs underline">
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
};

export { FailedPluginCard };
