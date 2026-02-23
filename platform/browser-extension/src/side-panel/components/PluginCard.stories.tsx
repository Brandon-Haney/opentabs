import { PluginCard } from './PluginCard';
import { Accordion } from './retro/Accordion';
import { useState } from 'react';
import type { PluginState } from '../bridge';
import type { Meta, StoryObj } from '@storybook/react';

const mockPlugin = (overrides?: Partial<PluginState>): PluginState => ({
  name: 'slack',
  displayName: 'Slack',
  version: '0.1.0',
  trustTier: 'local',
  source: 'local',
  tabState: 'ready',
  urlPatterns: ['*://*.slack.com/*'],
  sdkVersion: '0.0.3',
  tools: [
    { name: 'send_message', displayName: 'Send Message', description: 'Send a message', icon: 'send', enabled: true },
    { name: 'list_channels', displayName: 'List Channels', description: 'List channels', icon: 'list', enabled: true },
    { name: 'search', displayName: 'Search', description: 'Search messages', icon: 'search', enabled: false },
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
    mockPlugin({ update: { latestVersion: '0.2.0', updateCommand: 'npm update -g opentabs-plugin-slack@latest' } }),
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
          enabled: true,
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
          enabled: true,
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

export default meta;
export { Ready, TabClosed, TabUnavailable, ReadyWithUpdate, WithActiveTool, MultiplePlugins };
