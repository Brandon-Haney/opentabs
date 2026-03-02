# opentabs-plugin-discord

OpenTabs plugin for Discord

## Project Structure

```
discord/
├── package.json          # Plugin metadata (name, opentabs field, dependencies)
├── icon.svg              # Optional custom icon (square SVG, max 8KB)
├── icon-inactive.svg     # Optional manual inactive icon override
├── src/
│   ├── index.ts          # Plugin class (extends OpenTabsPlugin)
│   └── tools/            # One file per tool (using defineTool)
│       └── example.ts
└── dist/                 # Build output (generated)
    ├── adapter.iife.js   # Bundled adapter injected into matching tabs
    └── tools.json        # Tool schemas for MCP registration
```

## Configuration

Plugin metadata is defined in `package.json` under the `opentabs` field:

```json
{
  "name": "opentabs-plugin-discord",
  "main": "dist/adapter.iife.js",
  "opentabs": {
    "displayName": "Discord",
    "description": "OpenTabs plugin for Discord",
    "urlPatterns": ["*://discord.com/*"]
  }
}
```

- **`main`** — entry point for the bundled adapter IIFE
- **`opentabs.displayName`** — human-readable name shown in the side panel
- **`opentabs.description`** — short description of what the plugin does
- **`opentabs.urlPatterns`** — Chrome match patterns for tabs where the adapter is injected

## Custom Icons

By default, the side panel shows a colored letter avatar for your plugin. To use a custom icon, place an `icon.svg` file in the plugin root (next to `package.json`):

```
discord/
├── package.json
├── icon.svg              ← custom icon (optional)
├── icon-inactive.svg     ← manual inactive override (optional, requires icon.svg)
├── src/
│   └── ...
```

**How it works:**

- `opentabs-plugin build` reads `icon.svg`, validates it, auto-generates a grayscale inactive variant, and embeds both in `dist/tools.json`
- To override the auto-generated inactive icon, provide `icon-inactive.svg` (must use only grayscale colors)
- If no `icon.svg` is provided, the letter avatar is used automatically

**Icon requirements:**

- Square SVG with a `viewBox` attribute (e.g., `viewBox="0 0 32 32"`)
- Maximum 8 KB file size
- No embedded `<image>`, `<script>`, or event handler attributes (`onclick`, etc.)
- Manual `icon-inactive.svg` must use only achromatic (grayscale) colors

## Development

```bash
npm install
npm run build       # tsc && opentabs-plugin build
npm run dev         # watch mode (tsc --watch + opentabs-plugin build --watch)
npm run type-check  # tsc --noEmit
npm run lint        # eslint
```

## Adding Tools

Create a new file in `src/tools/` using `defineTool`:

```ts
import { z } from 'zod';
import { defineTool } from '@opentabs-dev/plugin-sdk';

export const myTool = defineTool({
  name: 'my_tool',
  displayName: 'My Tool',
  description: 'What this tool does',
  icon: 'wrench',
  input: z.object({ /* ... */ }),
  output: z.object({ /* ... */ }),
  handle: async (params) => {
    // Tool implementation runs in the browser tab context
    return { /* ... */ };
  },
});
```

Then register it in `src/index.ts` by adding it to the `tools` array.

## Shared Schemas

When 3 or more tools share the same input or output shape, extract common Zod schemas into a shared file to avoid duplication:

```ts
// src/schemas/channel.ts
import { z } from 'zod';

export const channelSchema = z.object({
  id: z.string().describe('Channel ID'),
  name: z.string().describe('Channel name'),
});

export type Channel = z.infer<typeof channelSchema>;
```

Then import and reuse in your tools:

```ts
// src/tools/list-channels.ts
import { channelSchema } from '../schemas/channel.js';

export const listChannels = defineTool({
  name: 'list_channels',
  displayName: 'List Channels',
  description: 'List all available channels',
  icon: 'list',
  input: z.object({}),
  output: z.object({ channels: z.array(channelSchema) }),
  handle: async () => {
    // ...
    return { channels: [] };
  },
});
```

This keeps your tool schemas DRY and makes it easy to evolve shared types in one place.
