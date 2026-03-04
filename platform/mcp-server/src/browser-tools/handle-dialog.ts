/**
 * browser_handle_dialog — handle JavaScript alert/confirm/prompt dialogs via CDP.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const handleDialog = defineBrowserTool({
  name: 'browser_handle_dialog',
  description:
    'Handle a JavaScript dialog (alert, confirm, prompt) that is blocking all script execution in a tab. ' +
    'JS dialogs (alert(), confirm(), prompt()) freeze the entire page until dismissed — no other browser tools ' +
    'will work while a dialog is open. Use action "accept" to confirm/dismiss alerts, "dismiss" to cancel. ' +
    'For prompt() dialogs, provide promptText with the text to enter before accepting. ' +
    'Common scenario: a tool call times out or errors because a dialog appeared — call this tool to dismiss it, ' +
    'then retry the original action.',
  summary: 'Handle a JavaScript dialog',
  icon: 'message-square',
  group: 'Page Interaction',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID of the page with the dialog'),
    action: z.enum(['accept', 'dismiss']).describe('Whether to accept (OK/Yes) or dismiss (Cancel) the dialog'),
    promptText: z
      .string()
      .optional()
      .describe('Text to enter in prompt() dialogs before accepting. Ignored for alert/confirm.'),
  }),
  handler: async (args, state) =>
    dispatchToExtension(state, 'browser.handleDialog', {
      tabId: args.tabId,
      action: args.action,
      ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
    }),
});

export { handleDialog };
