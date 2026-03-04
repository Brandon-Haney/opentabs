import type { ToolPermission } from '@opentabs-dev/shared';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { BrowserToolState } from '../bridge';
import { BrowserToolsCard } from './BrowserToolsCard';
import { Accordion } from './retro/Accordion';

const mockBrowserTools: BrowserToolState[] = [
  { name: 'browser_list_tabs', description: 'List all open browser tabs', permission: 'auto' },
  { name: 'browser_open_tab', description: 'Open a new browser tab with a URL', permission: 'auto' },
  { name: 'browser_screenshot_tab', description: 'Capture a screenshot of a tab', permission: 'auto' },
  { name: 'browser_click_element', description: 'Click an element matching a CSS selector', permission: 'auto' },
  { name: 'browser_execute_script', description: 'Execute JavaScript in a tab', permission: 'off' },
];

const meta: Meta<typeof BrowserToolsCard> = {
  title: 'Components/BrowserToolsCard',
  component: BrowserToolsCard,
  decorators: [
    Story => (
      <div className="w-80">
        <Accordion type="multiple" defaultValue={['browser-tools']}>
          {Story()}
        </Accordion>
      </div>
    ),
  ],
};

type Story = StoryObj<typeof BrowserToolsCard>;

const DefaultDemo = () => {
  const [tools, setTools] = useState<BrowserToolState[]>(
    mockBrowserTools.map(t => ({ ...t, permission: 'auto' as const })),
  );
  const [perm, setPerm] = useState<ToolPermission>('auto');
  return (
    <BrowserToolsCard
      tools={tools}
      activeTools={new Set()}
      onToolsChange={updater => setTools(updater)}
      browserPermission={perm}
      onBrowserPermissionChange={setPerm}
    />
  );
};

const Default: Story = {
  render: () => <DefaultDemo />,
};

const SomeDisabledDemo = () => {
  const [tools, setTools] = useState(mockBrowserTools);
  const [perm, setPerm] = useState<ToolPermission>('ask');
  return (
    <BrowserToolsCard
      tools={tools}
      activeTools={new Set()}
      onToolsChange={updater => setTools(updater)}
      browserPermission={perm}
      onBrowserPermissionChange={setPerm}
    />
  );
};

const SomeDisabled: Story = {
  render: () => <SomeDisabledDemo />,
};

const AllDisabledDemo = () => {
  const [tools, setTools] = useState<BrowserToolState[]>(
    mockBrowserTools.map(t => ({ ...t, permission: 'off' as const })),
  );
  const [perm, setPerm] = useState<ToolPermission>('off');
  return (
    <BrowserToolsCard
      tools={tools}
      activeTools={new Set()}
      onToolsChange={updater => setTools(updater)}
      browserPermission={perm}
      onBrowserPermissionChange={setPerm}
    />
  );
};

const AllDisabled: Story = {
  render: () => <AllDisabledDemo />,
};

const WithActiveToolDemo = () => {
  const [tools, setTools] = useState<BrowserToolState[]>(
    mockBrowserTools.map(t => ({ ...t, permission: 'auto' as const })),
  );
  const [perm, setPerm] = useState<ToolPermission>('auto');
  return (
    <BrowserToolsCard
      tools={tools}
      activeTools={new Set(['browser:browser_list_tabs'])}
      onToolsChange={updater => setTools(updater)}
      browserPermission={perm}
      onBrowserPermissionChange={setPerm}
    />
  );
};

const WithActiveTool: Story = {
  render: () => <WithActiveToolDemo />,
};

const WithToolFilterDemo = () => {
  const [tools, setTools] = useState<BrowserToolState[]>(
    mockBrowserTools.map(t => ({ ...t, permission: 'auto' as const })),
  );
  const [perm, setPerm] = useState<ToolPermission>('auto');
  return (
    <BrowserToolsCard
      tools={tools}
      activeTools={new Set()}
      onToolsChange={updater => setTools(updater)}
      toolFilter="screenshot"
      browserPermission={perm}
      onBrowserPermissionChange={setPerm}
    />
  );
};

const WithToolFilter: Story = {
  render: () => <WithToolFilterDemo />,
};

const interactiveTools: BrowserToolState[] = [
  ...mockBrowserTools,
  { name: 'extension_get_state', description: 'Get extension internal state', permission: 'auto' },
];

const InteractiveDemo = () => {
  const [tools, setTools] = useState(interactiveTools);
  const [perm, setPerm] = useState<ToolPermission>('auto');
  return (
    <BrowserToolsCard
      tools={tools}
      activeTools={new Set()}
      onToolsChange={updater => setTools(updater)}
      browserPermission={perm}
      onBrowserPermissionChange={setPerm}
    />
  );
};

const Interactive: Story = {
  render: () => <InteractiveDemo />,
};

const WithServerVersionDemo = () => {
  const [tools, setTools] = useState<BrowserToolState[]>(
    mockBrowserTools.map(t => ({ ...t, permission: 'auto' as const })),
  );
  const [perm, setPerm] = useState<ToolPermission>('auto');
  return (
    <BrowserToolsCard
      tools={tools}
      activeTools={new Set()}
      onToolsChange={updater => setTools(updater)}
      serverVersion="0.0.42"
      browserPermission={perm}
      onBrowserPermissionChange={setPerm}
    />
  );
};

const WithServerVersion: Story = {
  render: () => <WithServerVersionDemo />,
};

const SkipPermissionsDemo = () => {
  const [tools, setTools] = useState<BrowserToolState[]>(
    mockBrowserTools.map(t => ({ ...t, permission: 'auto' as const })),
  );
  return (
    <BrowserToolsCard
      tools={tools}
      activeTools={new Set()}
      onToolsChange={updater => setTools(updater)}
      browserPermission="auto"
      skipPermissions
    />
  );
};

const SkipPermissions: Story = {
  render: () => <SkipPermissionsDemo />,
};

export default meta;
export {
  Default,
  SomeDisabled,
  AllDisabled,
  WithActiveTool,
  WithToolFilter,
  Interactive,
  WithServerVersion,
  SkipPermissions,
};
