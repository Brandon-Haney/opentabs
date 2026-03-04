import type { ToolPermission } from '@opentabs-dev/shared';
import { cn } from '../lib/cn.js';
import { Select } from './retro/Select.js';
import { Tooltip } from './retro/Tooltip.js';
import { ToolIcon } from './ToolIcon.js';

const PERMISSION_LABELS: Record<ToolPermission, string> = {
  off: 'Off',
  ask: 'Ask',
  auto: 'Auto',
};

const PermissionSelect = ({
  value,
  onValueChange,
  disabled,
  ariaLabel,
}: {
  value: ToolPermission;
  onValueChange: (value: ToolPermission) => void;
  disabled: boolean;
  ariaLabel: string;
}) => (
  <Select value={value} onValueChange={v => onValueChange(v as ToolPermission)}>
    <Select.Trigger
      className="h-6 w-[4.5rem] min-w-0 px-1.5 py-0 font-mono text-xs shadow-none focus:shadow-[2px_2px_0_0_var(--color-border)]"
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      disabled={disabled}
      aria-label={ariaLabel}>
      <Select.Value />
    </Select.Trigger>
    <Select.Content className="font-mono text-xs">
      {(['off', 'ask', 'auto'] as const).map(p => (
        <Select.Item key={p} value={p}>
          {PERMISSION_LABELS[p]}
        </Select.Item>
      ))}
    </Select.Content>
  </Select>
);

const ToolRow = ({
  name,
  displayName,
  description,
  icon,
  permission,
  active,
  disabled,
  onPermissionChange,
}: {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  permission: ToolPermission;
  active: boolean;
  disabled?: boolean;
  onPermissionChange: (tool: string, permission: ToolPermission) => void;
}) => {
  const enabled = permission !== 'off';
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-border border-b px-3 py-1.5 transition-colors last:border-b-0 even:bg-muted/10',
        enabled ? 'hover:bg-primary/10' : 'hover:bg-muted/50',
        disabled && 'opacity-50',
      )}>
      <ToolIcon icon={icon} enabled={enabled} active={active} />
      <Tooltip>
        <Tooltip.Trigger asChild>
          <div className="min-w-0 flex-1">
            <div className="truncate text-foreground text-sm">{displayName}</div>
            <div className="truncate text-muted-foreground text-xs">{description}</div>
          </div>
        </Tooltip.Trigger>
        <Tooltip.Content>{description}</Tooltip.Content>
      </Tooltip>
      <div className="flex shrink-0 items-center gap-2">
        <select
          value={permission}
          onChange={e => onPermissionChange(name, e.target.value as ToolPermission)}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          disabled={disabled}
          aria-label={`Permission for ${name} tool`}
          className="rounded border-2 border-border bg-card px-1 py-0.5 font-mono text-xs focus:shadow-[2px_2px_0_0_var(--color-border)] focus:outline-none">
          <option value="off">Off</option>
          <option value="ask">Ask</option>
          <option value="auto">Auto</option>
        </select>
      </div>
    </div>
  );
};

export { PermissionSelect, ToolRow };
