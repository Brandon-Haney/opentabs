# Creating a Plugin

This guide walks through building an OpenTabs plugin from scratch.

## Scaffold a New Plugin

Use the scaffolding CLI:

```bash
bunx create-opentabs-plugin my-plugin
cd my-plugin
bun install
```

This creates the standard plugin structure:

```
my-plugin/
├── src/
│   ├── index.ts          # Plugin class
│   └── tools/            # One file per tool
│       └── example.ts
├── dist/                 # Built output
├── package.json
├── tsconfig.json
└── opentabs-plugin.json  # Generated manifest
```

## Define Your Plugin

Extend `OpenTabsPlugin` from the SDK:

```typescript
import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import { exampleTool } from './tools/example.js';

export default class MyPlugin extends OpenTabsPlugin {
  name = 'my-plugin';
  version = '1.0.0';
  urlPatterns = ['*://example.com/*'];
  tools = [exampleTool];

  isReady(): boolean {
    // Return true when the page is in a usable state
    // (e.g., user is logged in)
    return document.querySelector('.user-menu') !== null;
  }
}
```

## Define a Tool

Use `defineTool` to create tools with Zod schemas:

```typescript
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const exampleTool = defineTool({
  name: 'get_data',
  description: 'Fetch data from the application',
  input: z.object({
    query: z.string().describe('The search query'),
  }),
  handler: async ({ query }) => {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    return { results: data.items };
  },
});
```

The `handler` function runs in the page's MAIN world — it has access to the page's cookies, session, and same-origin APIs.

## Build

```bash
bun run build
```

This runs `tsc` for type checking, then `opentabs build` to:

1. Bundle the adapter into `dist/adapter.iife.js`
2. Generate `opentabs-plugin.json` from the plugin class

## Test Locally

Register the plugin in `~/.opentabs/config.json`:

```json
{
  "plugins": ["/path/to/my-plugin"]
}
```

The MCP server's file watcher detects changes automatically when you rebuild.

## Publish to npm

```bash
npm publish
```

Name your package `opentabs-plugin-<name>` or add `"opentabs-plugin"` to the `keywords` in `package.json` for automatic discovery.

## Next Steps

- [Plugin SDK Reference](/plugins/sdk) — Full API documentation
- [Plugin Configuration](/guide/plugin-config) — Configuration options
