import { PluginMenu } from './PluginMenu';
import type { PluginState } from '../bridge';
import type { Meta, StoryObj } from '@storybook/react';

const mockNpmPlugin = (overrides?: Partial<PluginState>): PluginState => ({
  name: 'slack',
  displayName: 'Slack',
  version: '0.1.0',
  trustTier: 'community',
  source: 'npm',
  tabState: 'ready',
  urlPatterns: ['*://*.slack.com/*'],
  sdkVersion: '0.0.3',
  tools: [
    { name: 'send_message', displayName: 'Send Message', description: 'Send a message', icon: 'send', enabled: true },
  ],
  ...overrides,
});

const meta: Meta<typeof PluginMenu> = {
  title: 'Components/PluginMenu',
  component: PluginMenu,
  decorators: [Story => <div className="p-8">{Story()}</div>],
};

type Story = StoryObj<typeof PluginMenu>;

const Default: Story = {
  render: () => (
    <PluginMenu
      plugin={mockNpmPlugin()}
      onUpdate={() => undefined}
      onRemove={() => undefined}
      updating={false}
      removing={false}
    />
  ),
};

const WithUpdate: Story = {
  render: () => (
    <PluginMenu
      plugin={mockNpmPlugin({ update: { latestVersion: '0.2.0', updateCommand: 'npm update slack' } })}
      onUpdate={() => undefined}
      onRemove={() => undefined}
      updating={false}
      removing={false}
    />
  ),
};

const LocalPlugin: Story = {
  render: () => (
    <div>
      <p className="text-muted-foreground mb-2 text-xs">Local plugin — PluginMenu renders nothing (null):</p>
      <PluginMenu
        plugin={mockNpmPlugin({ source: 'local' })}
        onUpdate={() => undefined}
        onRemove={() => undefined}
        updating={false}
        removing={false}
      />
      <p className="text-muted-foreground mt-2 text-xs">(nothing rendered above)</p>
    </div>
  ),
};

const ConfirmState: Story = {
  render: () => (
    <div>
      <p className="text-muted-foreground mb-2 text-xs">
        Open the menu to see Confirm? state after clicking Uninstall:
      </p>
      <PluginMenu
        plugin={mockNpmPlugin()}
        onUpdate={() => undefined}
        onRemove={() => undefined}
        updating={false}
        removing={false}
      />
    </div>
  ),
};

const AllStates: Story = {
  render: () => (
    <div className="space-y-4">
      <div>
        <p className="text-muted-foreground mb-1 text-xs">Default (no update)</p>
        <PluginMenu
          plugin={mockNpmPlugin()}
          onUpdate={() => undefined}
          onRemove={() => undefined}
          updating={false}
          removing={false}
        />
      </div>
      <div>
        <p className="text-muted-foreground mb-1 text-xs">With update available</p>
        <PluginMenu
          plugin={mockNpmPlugin({ update: { latestVersion: '0.2.0', updateCommand: 'npm update slack' } })}
          onUpdate={() => undefined}
          onRemove={() => undefined}
          updating={false}
          removing={false}
        />
      </div>
      <div>
        <p className="text-muted-foreground mb-1 text-xs">Updating (spinner on Update item)</p>
        <PluginMenu
          plugin={mockNpmPlugin({ update: { latestVersion: '0.2.0', updateCommand: 'npm update slack' } })}
          onUpdate={() => undefined}
          onRemove={() => undefined}
          updating={true}
          removing={false}
        />
      </div>
      <div>
        <p className="text-muted-foreground mb-1 text-xs">Removing (spinner on Uninstall item)</p>
        <PluginMenu
          plugin={mockNpmPlugin()}
          onUpdate={() => undefined}
          onRemove={() => undefined}
          updating={false}
          removing={true}
        />
      </div>
      <div>
        <p className="text-muted-foreground mb-1 text-xs">Local plugin (renders nothing)</p>
        <PluginMenu
          plugin={mockNpmPlugin({ source: 'local' })}
          onUpdate={() => undefined}
          onRemove={() => undefined}
          updating={false}
          removing={false}
        />
      </div>
    </div>
  ),
};

export default meta;
export { Default, WithUpdate, LocalPlugin, ConfirmState, AllStates };
