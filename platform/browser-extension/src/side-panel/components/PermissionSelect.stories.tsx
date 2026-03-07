import type { ToolPermission } from '@opentabs-dev/shared';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { PermissionSelect } from './ToolRow';

const meta: Meta<typeof PermissionSelect> = {
  title: 'Components/PermissionSelect',
  component: PermissionSelect,
  decorators: [Story => <div className="w-40 p-4">{Story()}</div>],
};

type Story = StoryObj<typeof PermissionSelect>;

const Off: Story = {
  args: { value: 'off', onValueChange: () => {}, disabled: false, ariaLabel: 'Permission' },
};

const Ask: Story = {
  args: { ...Off.args, value: 'ask' },
};

const Auto: Story = {
  args: { ...Off.args, value: 'auto' },
};

const Disabled: Story = {
  args: { ...Off.args, value: 'ask', disabled: true },
};

const Muted: Story = {
  args: { ...Off.args, value: 'auto', muted: true },
};

const InteractiveDemo = () => {
  const [value, setValue] = useState<ToolPermission>('ask');
  return <PermissionSelect value={value} onValueChange={setValue} disabled={false} ariaLabel="Permission" />;
};

const Interactive: Story = {
  render: () => <InteractiveDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('combobox');
    await userEvent.click(trigger);
    const autoOption = await screen.findByRole('option', { name: /auto/i });
    await userEvent.click(autoOption);
    await expect(trigger).toHaveTextContent('Auto');
  },
};

const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="w-16 font-mono text-foreground text-xs">Off:</span>
        <PermissionSelect value="off" onValueChange={() => {}} disabled={false} ariaLabel="Off permission" />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 font-mono text-foreground text-xs">Ask:</span>
        <PermissionSelect value="ask" onValueChange={() => {}} disabled={false} ariaLabel="Ask permission" />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 font-mono text-foreground text-xs">Auto:</span>
        <PermissionSelect value="auto" onValueChange={() => {}} disabled={false} ariaLabel="Auto permission" />
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 font-mono text-foreground text-xs">Disabled:</span>
        <PermissionSelect value="ask" onValueChange={() => {}} disabled ariaLabel="Disabled permission" />
      </div>
    </div>
  ),
};

export default meta;
export { Off, Ask, Auto, Disabled, Muted, Interactive, AllStates };
