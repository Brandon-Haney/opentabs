import type { Meta, StoryObj } from '@storybook/react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { Button } from './Button';
import { Dialog } from './Dialog';

const meta: Meta = {
  title: 'Retro/Dialog',
  decorators: [Story => <div className="p-8">{Story()}</div>],
};

type Story = StoryObj;

const Default: Story = {
  render: () => (
    <Dialog>
      <Dialog.Trigger asChild>
        <Button size="sm">Open Dialog</Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Header>Dialog Title</Dialog.Header>
        <Dialog.Body>
          <p className="text-foreground text-sm">This is a retro-styled dialog with header, body, and footer.</p>
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close asChild>
            <Button size="sm" variant="outline">
              Cancel
            </Button>
          </Dialog.Close>
          <Button size="sm">Confirm</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Open Dialog' });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await expect(dialog).toBeVisible();
  },
};

const Destructive: Story = {
  render: () => (
    <Dialog>
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline" className="text-destructive">
          Remove Plugin
        </Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Header className="border-destructive bg-destructive text-destructive-foreground">
          Remove Plugin
        </Dialog.Header>
        <Dialog.Body>
          <p className="text-foreground text-sm">
            Are you sure you want to remove <strong>Slack</strong>? This will remove the plugin from your config.
          </p>
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close asChild>
            <Button size="sm" variant="outline">
              Cancel
            </Button>
          </Dialog.Close>
          <Button size="sm" variant="outline" className="border-destructive text-destructive">
            Remove
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  ),
};

const BodyOnly: Story = {
  render: () => (
    <Dialog>
      <Dialog.Trigger asChild>
        <Button size="sm">Minimal</Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Header>Notice</Dialog.Header>
        <Dialog.Body>
          <p className="text-foreground text-sm">A dialog with just a header and body, no footer.</p>
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  ),
};

const LongContent: Story = {
  render: () => (
    <Dialog>
      <Dialog.Trigger asChild>
        <Button size="sm">Open Long Dialog</Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Header>Approve Tool</Dialog.Header>
        <Dialog.Body>
          <pre className="wrap-anywhere whitespace-pre-wrap rounded border border-border bg-card px-2 py-1 font-mono text-xs leading-tight">
            {JSON.stringify(
              {
                message_id: 'AQMkADM5MDU3YjEyLTE0ZTgtNDgxZC1hNGRlLWFmYmM4ZGY0YjcxYQBGAAAD',
                draft: true,
                body_type: 'html',
                body: `<p style="font-family:Aptos,Calibri,sans-serif">${'Long unbroken content. '.repeat(40)}</p>`,
              },
              null,
              2,
            )}
          </pre>
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close asChild>
            <Button size="sm" variant="outline">
              Deny
            </Button>
          </Dialog.Close>
          <Button size="sm">Allow</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Open Long Dialog' }));
    const dialog = await screen.findByRole('dialog');
    await expect(dialog).toBeVisible();
    // The footer actions stay reachable no matter how tall the body content is.
    await expect(screen.getByRole('button', { name: 'Allow' })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Deny' })).toBeVisible();
    await expect(dialog.scrollWidth).toBe(dialog.clientWidth);
  },
};

export default meta;
export { BodyOnly, Default, Destructive, LongContent };
