import { MoreHorizontal, Server } from 'lucide-react';
import { Menu } from './retro/Menu';

interface BrowserToolsMenuProps {
  serverVersion?: string;
  className?: string;
}

const BrowserToolsMenu = ({ serverVersion, className }: BrowserToolsMenuProps) => (
  <div
    className={className}
    onClick={e => e.stopPropagation()}
    onKeyDown={e => {
      if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
    }}
    role="presentation">
    <Menu>
      <Menu.Trigger asChild>
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-muted/50"
          aria-label="Browser tools options">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </Menu.Trigger>
      <Menu.Content align="end">
        <Menu.Item disabled className="text-muted-foreground">
          <Server className="h-3.5 w-3.5" />
          Server {serverVersion ? `v${serverVersion}` : 'unknown'}
        </Menu.Item>
      </Menu.Content>
    </Menu>
  </div>
);

BrowserToolsMenu.displayName = 'BrowserToolsMenu';

export { BrowserToolsMenu };
export type { BrowserToolsMenuProps };
