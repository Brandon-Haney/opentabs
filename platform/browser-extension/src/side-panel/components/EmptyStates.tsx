import { Empty } from './retro/Empty.js';
import { Loader } from './retro/Loader.js';
import { useState, useEffect } from 'react';
import type { DisconnectReason } from '../../extension-messages.js';

const DEFAULT_PORT = 9515;
const STORAGE_KEY = 'serverPort';

const ConnectionRefusedState = () => {
  const [port, setPort] = useState(DEFAULT_PORT);

  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY).then(
      result => {
        const stored = result[STORAGE_KEY] as number | undefined;
        if (typeof stored === 'number' && stored >= 1 && stored <= 65535) {
          setPort(stored);
        }
      },
      () => {
        // Storage unavailable — keep default
      },
    );
  }, []);

  const command = port === DEFAULT_PORT ? 'opentabs start' : `opentabs start --port ${port}`;

  return (
    <Empty className="border-destructive/60">
      <Empty.Content>
        <Empty.Title>Cannot Reach MCP Server</Empty.Title>
        <Empty.Separator className="bg-destructive" />
        <Empty.Description>Start the MCP server:</Empty.Description>
        <code className="border-destructive/40 bg-destructive/10 rounded border-2 px-3 py-2 font-mono text-sm">
          {command}
        </code>
      </Empty.Content>
    </Empty>
  );
};

const AuthFailedState = () => (
  <Empty className="border-destructive/60">
    <Empty.Content>
      <Empty.Title>Authentication Failed</Empty.Title>
      <Empty.Separator className="bg-destructive" />
      <Empty.Description>
        The extension&rsquo;s secret does not match the server. Reload the extension to pick up the latest secret:
      </Empty.Description>
      <code className="border-destructive/40 bg-destructive/10 rounded border-2 px-3 py-2 font-mono text-sm">
        chrome://extensions/ → reload
      </code>
    </Empty.Content>
  </Empty>
);

const DisconnectedState = ({ reason }: { reason?: DisconnectReason }) => {
  if (reason === 'auth_failed') return <AuthFailedState />;
  return <ConnectionRefusedState />;
};

const NoPluginsState = () => (
  <Empty>
    <Empty.Content>
      <Empty.Title>No Plugins Installed</Empty.Title>
      <Empty.Separator />
      <Empty.Description>Manage plugins with:</Empty.Description>
      <code className="rounded border-2 px-3 py-2 font-mono text-sm">opentabs plugin</code>
    </Empty.Content>
  </Empty>
);

const LoadingState = () => <Loader size="md" />;

export { DisconnectedState, NoPluginsState, LoadingState };
