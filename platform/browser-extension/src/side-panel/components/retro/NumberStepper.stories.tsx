import type { Meta, StoryObj } from '@storybook/react';
import { NumberStepper } from './NumberStepper';

const meta: Meta<typeof NumberStepper> = {
  title: 'Retro/NumberStepper',
  component: NumberStepper,
};

type Story = StoryObj<typeof NumberStepper>;

const Default: Story = {
  args: { defaultValue: 9515, 'aria-label': 'Port' },
};

const FiveDigitPort: Story = {
  args: { defaultValue: 65535, 'aria-label': 'Port' },
};

const TwoDigitPort: Story = {
  args: { defaultValue: 80, 'aria-label': 'Port' },
};

const Disabled: Story = {
  args: { defaultValue: 9515, disabled: true, 'aria-label': 'Port' },
};

const CustomRange: Story = {
  args: { defaultValue: 100, min: 0, max: 1000, step: 10, 'aria-label': 'Value' },
};

const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="w-24 font-mono text-muted-foreground text-xs">4-digit</span>
        <NumberStepper defaultValue={9515} aria-label="Port" className="h-7" />
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 font-mono text-muted-foreground text-xs">5-digit</span>
        <NumberStepper defaultValue={65535} aria-label="Port" className="h-7" />
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 font-mono text-muted-foreground text-xs">2-digit</span>
        <NumberStepper defaultValue={80} aria-label="Port" className="h-7" />
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 font-mono text-muted-foreground text-xs">with label</span>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-muted-foreground text-xs">Port:</span>
          <NumberStepper defaultValue={3000} aria-label="Port" className="h-7" />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 font-mono text-muted-foreground text-xs">disabled</span>
        <NumberStepper defaultValue={9515} disabled aria-label="Port" className="h-7" />
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 font-mono text-muted-foreground text-xs">step=10</span>
        <NumberStepper defaultValue={100} min={0} max={1000} step={10} aria-label="Value" className="h-7" />
      </div>
    </div>
  ),
};

export default meta;
export { Default, FiveDigitPort, TwoDigitPort, Disabled, CustomRange, AllStates };
