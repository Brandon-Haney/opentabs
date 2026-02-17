# Plugin SDK

The `@opentabs-dev/plugin-sdk` package provides the base class and utilities for building OpenTabs plugins.

## `OpenTabsPlugin`

Base class that all plugins extend.

```typescript
import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';

export default class MyPlugin extends OpenTabsPlugin {
  name = 'my-plugin';
  version = '1.0.0';
  urlPatterns = ['*://app.example.com/*'];
  tools = [
    /* tool definitions */
  ];

  isReady(): boolean {
    return true;
  }
}
```

### Properties

| Property      | Type       | Description                              |
| ------------- | ---------- | ---------------------------------------- |
| `name`        | `string`   | Plugin identifier, used as tool prefix   |
| `version`     | `string`   | Semver version string                    |
| `urlPatterns` | `string[]` | Chrome match patterns for tab activation |
| `tools`       | `Tool[]`   | Array of tool definitions                |

### Methods

| Method      | Returns   | Description                                                         |
| ----------- | --------- | ------------------------------------------------------------------- |
| `isReady()` | `boolean` | Whether the page is in a usable state (e.g., user is authenticated) |

## `defineTool`

Factory function for creating type-safe tool definitions.

```typescript
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

const myTool = defineTool({
  name: 'tool_name',
  description: 'What this tool does',
  input: z.object({
    /* Zod schema */
  }),
  handler: async input => {
    // Runs in page context
    return {
      /* result */
    };
  },
});
```

### Options

| Option        | Type                      | Description                                     |
| ------------- | ------------------------- | ----------------------------------------------- |
| `name`        | `string`                  | Tool name (prefixed with plugin name for MCP)   |
| `description` | `string`                  | Description shown to AI agents                  |
| `input`       | `ZodSchema`               | Zod schema defining input parameters            |
| `handler`     | `(input) => Promise<any>` | Function that executes in the page's MAIN world |

## CLI: `opentabs build`

Bundles the plugin adapter and generates the manifest.

```bash
bunx opentabs build
```

**What it does:**

1. Reads the plugin class from `src/index.ts`
2. Bundles all code into `dist/adapter.iife.js` (IIFE format for MAIN world injection)
3. Generates `opentabs-plugin.json` with metadata extracted from the plugin class
