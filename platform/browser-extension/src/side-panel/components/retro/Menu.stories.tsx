import { Button } from './Button';
import { Menu } from './Menu';
import type { Meta, StoryObj } from '@storybook/react';

const meta: Meta = {
  title: 'Retro/Menu',
  decorators: [Story => <div className="p-16">{Story()}</div>],
};

type Story = StoryObj;

const Default: Story = {
  render: () => (
    <Menu>
      <Menu.Trigger asChild>
        <Button size="sm">Open Menu</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item>Item One</Menu.Item>
        <Menu.Item>Item Two</Menu.Item>
        <Menu.Item>Item Three</Menu.Item>
      </Menu.Content>
    </Menu>
  ),
};

const TopAligned: Story = {
  render: () => (
    <div className="mt-40">
      <Menu>
        <Menu.Trigger asChild>
          <Button size="sm">Open Above</Button>
        </Menu.Trigger>
        <Menu.Content side="top" align="end">
          <Menu.Item>For this tool on this domain</Menu.Item>
          <Menu.Item>For this tool everywhere</Menu.Item>
          <Menu.Item>For all tools on example.com</Menu.Item>
        </Menu.Content>
      </Menu>
    </div>
  ),
};

const Disabled: Story = {
  render: () => (
    <Menu>
      <Menu.Trigger asChild>
        <Button size="sm" disabled>
          Disabled
        </Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item>Item One</Menu.Item>
      </Menu.Content>
    </Menu>
  ),
};

const WithSeparator: Story = {
  render: () => (
    <Menu>
      <Menu.Trigger asChild>
        <Button size="sm">Open Menu</Button>
      </Menu.Trigger>
      <Menu.Content>
        <Menu.Item>Edit</Menu.Item>
        <Menu.Item>Duplicate</Menu.Item>
        <Menu.Separator />
        <Menu.Item className="text-destructive hover:text-destructive data-[highlighted]:text-destructive">
          Delete
        </Menu.Item>
      </Menu.Content>
    </Menu>
  ),
};

export default meta;
export { Default, Disabled, TopAligned, WithSeparator };
