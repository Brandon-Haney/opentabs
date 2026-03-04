/**
 * browser_select_option — select an option from a <select> dropdown element.
 */

import { z } from 'zod';
import { dispatchToExtension } from '../extension-protocol.js';
import { defineBrowserTool } from './definition.js';

const selectOption = defineBrowserTool({
  name: 'browser_select_option',
  description:
    'Select an option from a <select> dropdown element by option value or visible label text. Dispatches a change ' +
    'event after selection. Specify either value or label — value takes precedence if both provided.',
  summary: 'Select an option from a dropdown',
  icon: 'chevrons-up-down',
  group: 'Page Interaction',
  input: z.object({
    tabId: z.number().int().positive().describe('Tab ID of the page to interact with'),
    selector: z.string().min(1).describe('CSS selector of the <select> element'),
    value: z.string().optional().describe('Option value attribute to select'),
    label: z.string().optional().describe('Option visible text to select — used when value is not provided'),
  }),
  handler: async (args, state) => {
    if (args.value === undefined && args.label === undefined) {
      throw new Error('At least one of "value" or "label" must be provided');
    }
    return dispatchToExtension(state, 'browser.selectOption', {
      tabId: args.tabId,
      selector: args.selector,
      value: args.value,
      label: args.label,
    });
  },
});

export { selectOption };
