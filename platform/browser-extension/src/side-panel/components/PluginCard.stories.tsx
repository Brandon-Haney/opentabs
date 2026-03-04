import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { PluginState } from '../bridge';
import { PluginCard } from './PluginCard';
import { Accordion } from './retro/Accordion';

const mockPlugin = (overrides?: Partial<PluginState>): PluginState => ({
  name: 'slack',
  displayName: 'Slack',
  version: '0.1.0',
  permission: 'auto',
  source: 'local',
  tabState: 'ready',
  urlPatterns: ['*://*.slack.com/*'],
  sdkVersion: '0.0.3',
  tools: [
    {
      name: 'send_message',
      displayName: 'Send Message',
      description: 'Send a message',
      icon: 'send',
      permission: 'auto',
    },
    {
      name: 'list_channels',
      displayName: 'List Channels',
      description: 'List channels',
      icon: 'list',
      permission: 'auto',
    },
    {
      name: 'search',
      displayName: 'Search',
      description: 'Search messages',
      icon: 'search',
      permission: 'off',
    },
  ],
  ...overrides,
});

const meta: Meta<typeof PluginCard> = {
  title: 'Components/PluginCard',
  component: PluginCard,
  decorators: [
    Story => (
      <div className="w-80">
        <Accordion type="multiple" defaultValue={['slack', 'github', 'datadog']}>
          {Story()}
        </Accordion>
      </div>
    ),
  ],
};

type Story = StoryObj<typeof PluginCard>;

const ReadyDemo = () => {
  const [plugins, setPlugins] = useState([mockPlugin()]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return <PluginCard plugin={plugin} activeTools={new Set()} setPlugins={setPlugins} />;
};

const Ready: Story = {
  render: () => <ReadyDemo />,
};

const TabClosedDemo = () => {
  const [plugins, setPlugins] = useState([mockPlugin({ tabState: 'closed' })]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return <PluginCard plugin={plugin} activeTools={new Set()} setPlugins={setPlugins} />;
};

const TabClosed: Story = {
  render: () => <TabClosedDemo />,
};

const TabUnavailableDemo = () => {
  const [plugins, setPlugins] = useState([mockPlugin({ tabState: 'unavailable' })]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return <PluginCard plugin={plugin} activeTools={new Set()} setPlugins={setPlugins} />;
};

const TabUnavailable: Story = {
  render: () => <TabUnavailableDemo />,
};

const ReadyWithUpdateDemo = () => {
  const [plugins, setPlugins] = useState([
    mockPlugin({
      update: {
        latestVersion: '0.2.0',
        updateCommand: 'npm update -g opentabs-plugin-slack@latest',
      },
    }),
  ]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return <PluginCard plugin={plugin} activeTools={new Set()} setPlugins={setPlugins} />;
};

const ReadyWithUpdate: Story = {
  render: () => <ReadyWithUpdateDemo />,
};

const WithActiveToolDemo = () => {
  const [plugins, setPlugins] = useState([mockPlugin()]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return <PluginCard plugin={plugin} activeTools={new Set(['slack:send_message'])} setPlugins={setPlugins} />;
};

const WithActiveTool: Story = {
  render: () => <WithActiveToolDemo />,
};

const MultiplePluginsDemo = () => {
  const [plugins, setPlugins] = useState([
    mockPlugin(),
    mockPlugin({
      name: 'github',
      displayName: 'GitHub',
      urlPatterns: ['*://github.com/*'],
      tabState: 'closed',
      tools: [
        {
          name: 'create_issue',
          displayName: 'Create Issue',
          description: 'Create issue',
          icon: 'plus',
          permission: 'auto',
        },
      ],
    }),
    mockPlugin({
      name: 'datadog',
      displayName: 'Datadog',
      urlPatterns: ['*://*.datadoghq.com/*'],
      tabState: 'unavailable',
      source: 'npm',
      tools: [
        {
          name: 'query_metrics',
          displayName: 'Query Metrics',
          description: 'Query metrics',
          icon: 'bar-chart',
          permission: 'auto',
        },
      ],
    }),
  ]);
  return (
    <div className="space-y-2">
      {plugins.map(p => (
        <PluginCard key={p.name} plugin={p} activeTools={new Set(['slack:send_message'])} setPlugins={setPlugins} />
      ))}
    </div>
  );
};

const MultiplePlugins: Story = {
  render: () => <MultiplePluginsDemo />,
};

const WithMenuDemo = () => {
  const [plugins, setPlugins] = useState([mockPlugin({ source: 'npm', permission: 'auto', tabState: 'ready' })]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return (
    <PluginCard
      plugin={plugin}
      activeTools={new Set()}
      setPlugins={setPlugins}
      onUpdate={() => undefined}
      onRemove={() => undefined}
    />
  );
};

const WithMenu: Story = {
  render: () => <WithMenuDemo />,
};

const WithMenuAndUpdateDemo = () => {
  const [plugins, setPlugins] = useState([
    mockPlugin({
      source: 'npm',
      permission: 'auto',
      tabState: 'ready',
      update: {
        latestVersion: '0.2.0',
        updateCommand: 'npm update -g opentabs-plugin-slack@latest',
      },
    }),
  ]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return (
    <PluginCard
      plugin={plugin}
      activeTools={new Set()}
      setPlugins={setPlugins}
      onUpdate={() => undefined}
      onRemove={() => undefined}
    />
  );
};

const WithMenuAndUpdate: Story = {
  render: () => <WithMenuAndUpdateDemo />,
};

const RemovingStateDemo = () => {
  const [plugins, setPlugins] = useState([mockPlugin({ source: 'npm', permission: 'auto', tabState: 'ready' })]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return (
    <PluginCard
      plugin={plugin}
      activeTools={new Set()}
      setPlugins={setPlugins}
      onUpdate={() => undefined}
      onRemove={() => undefined}
      removingPlugin={true}
    />
  );
};

const RemovingState: Story = {
  render: () => <RemovingStateDemo />,
};

const GroupedToolsDemo = () => {
  const [plugins, setPlugins] = useState([
    mockPlugin({
      tools: [
        {
          name: 'send_message',
          displayName: 'Send Message',
          description: 'Send a message to a channel or DM conversation',
          icon: 'send',
          permission: 'auto',
          group: 'Messages',
        },
        {
          name: 'read_messages',
          displayName: 'Read Messages',
          description: 'Read recent messages from a channel',
          icon: 'message-square',
          permission: 'auto',
          group: 'Messages',
        },
        {
          name: 'search_messages',
          displayName: 'Search Messages',
          description: 'Search messages across channels using keywords and filters',
          icon: 'search',
          permission: 'auto',
          group: 'Messages',
        },
        {
          name: 'edit_message',
          displayName: 'Edit Message',
          description: 'Edit a previously sent message',
          icon: 'pencil',
          permission: 'off',
          group: 'Messages',
        },
        {
          name: 'list_channels',
          displayName: 'List Channels',
          description: 'List all public and private channels in the workspace',
          icon: 'list',
          permission: 'auto',
          group: 'Channels',
        },
        {
          name: 'create_channel',
          displayName: 'Create Channel',
          description: 'Create a new public or private channel',
          icon: 'plus',
          permission: 'auto',
          group: 'Channels',
        },
        {
          name: 'get_channel_info',
          displayName: 'Get Channel Info',
          description: 'Get details about a channel including topic, purpose, and members',
          icon: 'info',
          permission: 'auto',
          group: 'Channels',
        },
        {
          name: 'list_users',
          displayName: 'List Users',
          description: 'List all users in the workspace',
          icon: 'users',
          permission: 'auto',
          group: 'Users',
        },
        {
          name: 'get_user_profile',
          displayName: 'Get User Profile',
          description: 'Retrieve a user profile including display name, email, and timezone',
          icon: 'user',
          permission: 'auto',
          group: 'Users',
        },
        {
          name: 'add_reaction',
          displayName: 'Add Reaction',
          description: 'Add an emoji reaction to a message',
          icon: 'smile',
          permission: 'auto',
          group: 'Reactions',
        },
        {
          name: 'pin_message',
          displayName: 'Pin Message',
          description: 'Pin a message to a channel',
          icon: 'pin',
          permission: 'off',
          group: 'Reactions',
        },
      ],
    }),
  ]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return <PluginCard plugin={plugin} activeTools={new Set(['slack:send_message'])} setPlugins={setPlugins} />;
};

const GroupedTools: Story = {
  render: () => <GroupedToolsDemo />,
};

const MixedGroupedUngroupedDemo = () => {
  const [plugins, setPlugins] = useState([
    mockPlugin({
      tools: [
        {
          name: 'send_message',
          displayName: 'Send Message',
          description: 'Send a message to a channel',
          icon: 'send',
          permission: 'auto',
          group: 'Messages',
        },
        {
          name: 'read_messages',
          displayName: 'Read Messages',
          description: 'Read recent messages from a channel',
          icon: 'message-square',
          permission: 'auto',
          group: 'Messages',
        },
        {
          name: 'list_channels',
          displayName: 'List Channels',
          description: 'List all channels in the workspace',
          icon: 'list',
          permission: 'auto',
          group: 'Channels',
        },
        {
          name: 'upload_file',
          displayName: 'Upload File',
          description: 'Upload a file to a channel with an optional comment',
          icon: 'upload',
          permission: 'auto',
        },
        {
          name: 'open_dm',
          displayName: 'Open DM',
          description: 'Open a direct message conversation with a user',
          icon: 'message-circle',
          permission: 'auto',
        },
      ],
    }),
  ]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return <PluginCard plugin={plugin} activeTools={new Set()} setPlugins={setPlugins} />;
};

const MixedGroupedUngrouped: Story = {
  render: () => <MixedGroupedUngroupedDemo />,
};

const SkipPermissionsDemo = () => {
  const [plugins, setPlugins] = useState([mockPlugin()]);
  const plugin = plugins[0];
  if (!plugin) return null;
  return <PluginCard plugin={plugin} activeTools={new Set()} setPlugins={setPlugins} skipPermissions />;
};

const SkipPermissions: Story = {
  render: () => <SkipPermissionsDemo />,
};

export default meta;
export {
  Ready,
  TabClosed,
  TabUnavailable,
  ReadyWithUpdate,
  WithActiveTool,
  MultiplePlugins,
  WithMenu,
  WithMenuAndUpdate,
  RemovingState,
  GroupedTools,
  MixedGroupedUngrouped,
  SkipPermissions,
};
