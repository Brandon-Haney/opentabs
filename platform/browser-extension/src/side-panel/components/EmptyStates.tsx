import { Empty } from './retro/Empty.js';
import { Loader } from './retro/Loader.js';

const DisconnectedState = () => (
  <Empty className="border-destructive/60">
    <Empty.Content>
      <Empty.Title>Cannot Reach MCP Server</Empty.Title>
      <Empty.Separator className="bg-destructive" />
      <Empty.Description>Start the MCP server:</Empty.Description>
      <code className="border-destructive/40 bg-destructive/10 rounded border-2 px-3 py-2 font-mono text-sm">
        opentabs start
      </code>
    </Empty.Content>
  </Empty>
);

const LoadingState = () => <Loader size="md" />;

const EmptyState = () => (
  <Empty>
    <Empty.Content>
      <Empty.Title>No Plugins</Empty.Title>
      <Empty.Separator />
      <Empty.Description>Add a plugin path to ~/.opentabs/config.json or install one from npm.</Empty.Description>
    </Empty.Content>
  </Empty>
);

export { DisconnectedState, LoadingState, EmptyState };
