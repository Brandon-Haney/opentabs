/**
 * extension_get_logs — retrieves internal logs from the Chrome extension's
 * background script and offscreen document. Combines logs from both contexts,
 * sorted newest-first, with optional filtering by level, source, and time.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const extensionGetLogs = defineBrowserTool({
  name: 'extension_get_logs',
  description:
    'Retrieve internal logs from the OpenTabs Chrome extension (background script and offscreen document). ' +
    'Returns log entries with timestamp, level, source, and message. ' +
    'Use this to see error messages, WebSocket events, and plugin injection warnings without opening DevTools.',
  summary: 'Get extension internal logs',
  icon: 'scroll-text',
  group: 'Extension',
  input: z.object({
    level: z
      .enum(['log', 'warn', 'error', 'info', 'all'])
      .optional()
      .describe('Filter by log level. Defaults to all levels.'),
    source: z
      .enum(['background', 'offscreen', 'all'])
      .optional()
      .describe('Filter by source context. Defaults to all sources.'),
    limit: z.number().int().positive().optional().describe('Maximum number of entries to return. Defaults to 100.'),
    since: z.number().optional().describe('Only return entries with timestamp >= this value (ms since epoch).'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'extension.getLogs', {
      ...(args.level !== undefined && args.level !== 'all' ? { level: args.level } : {}),
      ...(args.source !== undefined && args.source !== 'all' ? { source: args.source } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.since !== undefined ? { since: args.since } : {}),
    }),
});

export { extensionGetLogs };
