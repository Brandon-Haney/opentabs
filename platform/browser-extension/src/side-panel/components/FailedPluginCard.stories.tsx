import type { Meta, StoryObj } from '@storybook/react';
import { FailedPluginCard } from './FailedPluginCard';

const meta: Meta<typeof FailedPluginCard> = {
  title: 'Components/FailedPluginCard',
  component: FailedPluginCard,
  decorators: [Story => <div className="w-80">{Story()}</div>],
};

type Story = StoryObj<typeof FailedPluginCard>;

const ShortError: Story = {
  args: { plugin: { specifier: '/Users/dev/plugins/broken', error: 'Missing dist/tools.json' } },
};

const LongError: Story = {
  args: {
    plugin: {
      specifier: '/Users/dev/plugins/broken',
      error:
        'Error: Cannot find module "@opentabs-dev/plugin-sdk/tools" from "/Users/dev/plugins/broken/src/index.ts". Make sure the package is installed and the module path is correct. Did you mean to import "@opentabs-dev/plugin-sdk"?',
    },
  },
};

const NpmSpecifier: Story = {
  args: {
    plugin: {
      specifier: '@opentabs-dev/plugin-slack@1.2.3',
      error: 'Failed to load adapter: adapter IIFE threw during evaluation',
    },
  },
};

const AllStates: Story = {
  render: () => (
    <div className="space-y-3">
      <FailedPluginCard plugin={{ specifier: '/Users/dev/plugins/broken', error: 'Missing dist/tools.json' }} />
      <FailedPluginCard
        plugin={{
          specifier: '/Users/dev/plugins/broken',
          error:
            'Error: Cannot find module "@opentabs-dev/plugin-sdk/tools" from "/Users/dev/plugins/broken/src/index.ts". Make sure the package is installed and the module path is correct. Did you mean to import "@opentabs-dev/plugin-sdk"?',
        }}
      />
      <FailedPluginCard
        plugin={{
          specifier: '@opentabs-dev/plugin-slack@1.2.3',
          error: 'Failed to load adapter: adapter IIFE threw during evaluation',
        }}
      />
    </div>
  ),
};

export default meta;
export { ShortError, LongError, NpmSpecifier, AllStates };
