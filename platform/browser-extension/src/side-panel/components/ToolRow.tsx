import { cn } from '../lib/cn.js';
import { Switch } from './retro/Switch.js';
import { Tooltip } from './retro/Tooltip.js';
import { ToolIcon } from './ToolIcon.js';

const ToolRow = ({
  name,
  displayName,
  description,
  icon,
  enabled,
  active,
  onToggle,
}: {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  enabled: boolean;
  active: boolean;
  onToggle: () => void;
}) => (
  <div
    className={cn(
      'flex items-center gap-2 border-border border-b px-3 py-2 transition-colors last:border-b-0',
      enabled ? 'hover:bg-primary/10' : 'hover:bg-muted/50',
    )}>
    <ToolIcon icon={icon} enabled={enabled} active={active} />
    <Tooltip>
      <Tooltip.Trigger asChild>
        <div className="min-w-0 flex-1">
          <div className="truncate text-foreground text-sm">{displayName}</div>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Content>{description}</Tooltip.Content>
    </Tooltip>
    <div className="flex shrink-0 items-center gap-2">
      <Switch
        checked={enabled}
        onCheckedChange={() => onToggle()}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        aria-label={`Toggle ${name} tool`}
      />
    </div>
  </div>
);

export { ToolRow };
