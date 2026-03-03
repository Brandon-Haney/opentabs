import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ToolRow } from './ToolRow';

const meta: Meta<typeof ToolRow> = {
  title: 'Components/ToolRow',
  component: ToolRow,
  decorators: [Story => <div className="w-80 rounded border-2 border-border">{Story()}</div>],
};

type Story = StoryObj<typeof ToolRow>;

const Enabled: Story = {
  args: {
    name: 'send_message',
    displayName: 'Send Message',
    description: 'Send a message',
    icon: 'send',
    enabled: true,
    active: false,
    onToggle: () => {},
  },
};

const Active: Story = { args: { ...Enabled.args, active: true } };

const InteractiveDemo = () => {
  const [enabled, setEnabled] = useState(true);
  return (
    <ToolRow
      name="send_message"
      displayName="Send Message"
      description="Send a message"
      icon="send"
      enabled={enabled}
      active={false}
      onToggle={() => setEnabled(v => !v)}
    />
  );
};

const Interactive: Story = {
  render: () => <InteractiveDemo />,
};

const ToolList: Story = {
  render: () => {
    const tools = [
      { name: 'send_message', displayName: 'Send Message', description: 'Send a message', icon: 'send' },
      { name: 'list_channels', displayName: 'List Channels', description: 'List channels', icon: 'list' },
      { name: 'search', displayName: 'Search', description: 'Search messages', icon: 'search' },
    ];
    return (
      <div>
        {tools.map(t => (
          <ToolRow key={t.name} {...t} enabled={true} active={t.name === 'search'} onToggle={() => {}} />
        ))}
      </div>
    );
  },
};

export default meta;
export { Enabled, Active, Interactive, ToolList };
