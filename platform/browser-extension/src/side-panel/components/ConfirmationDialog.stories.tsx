import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { ConfirmationData } from './ConfirmationDialog';
import { ConfirmationDialog } from './ConfirmationDialog';

const mockConfirmation = (overrides?: Partial<ConfirmationData>): ConfirmationData => ({
  id: 'conf-1',
  tool: 'send_message',
  plugin: 'slack',
  params: {},
  ...overrides,
});

const meta: Meta<typeof ConfirmationDialog> = {
  title: 'Components/ConfirmationDialog',
  component: ConfirmationDialog,
  args: {
    onRespond: fn(),
  },
};

type Story = StoryObj<typeof ConfirmationDialog>;

const SingleConfirmation: Story = {
  args: {
    confirmations: [mockConfirmation()],
  },
};

const WithParams: Story = {
  args: {
    confirmations: [
      mockConfirmation({
        id: 'conf-params',
        tool: 'send_message',
        plugin: 'slack',
        params: { channel: '#general', message: 'Hello team!' },
      }),
    ],
  },
};

const BrowserTool: Story = {
  args: {
    confirmations: [
      mockConfirmation({
        id: 'conf-browser',
        tool: 'screenshot',
        plugin: 'browser',
        params: { tabId: 12345 },
      }),
    ],
  },
};

const MultipleConfirmations: Story = {
  args: {
    confirmations: [
      mockConfirmation({ id: 'conf-1', tool: 'send_message', plugin: 'slack' }),
      mockConfirmation({ id: 'conf-2', tool: 'create_issue', plugin: 'github', params: { title: 'Bug report' } }),
      mockConfirmation({ id: 'conf-3', tool: 'screenshot', plugin: 'browser' }),
    ],
  },
};

export default meta;
export { SingleConfirmation, WithParams, BrowserTool, MultipleConfirmations };
