import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const navigateTo = defineTool({
  name: 'navigate_to',
  displayName: 'Navigate To',
  description:
    'Navigate Gmail to a specific view using URL hash routing: inbox, starred, sent, drafts, trash, spam, all mail, ' +
    'a specific label, or a search query. This triggers Gmail SPA to fetch and render the corresponding data.',
  summary: 'Navigate to a Gmail label or view',
  icon: 'navigation',
  group: 'Navigation',
  input: z.object({
    view: z
      .string()
      .min(1)
      .describe(
        'Gmail view to navigate to. Use "inbox", "starred", "sent", "drafts", "trash", ' +
          '"spam", "all", or "label/<label-name>" for custom labels.',
      ),
  }),
  output: z.object({
    navigated: z.boolean().describe('Whether navigation was triggered'),
    current_view: z.string().describe('Current Gmail URL hash after navigation'),
  }),
  handle: async params => {
    const viewMap: Record<string, string> = {
      inbox: '#inbox',
      starred: '#starred',
      sent: '#sent',
      drafts: '#drafts',
      trash: '#trash',
      spam: '#spam',
      all: '#all',
      snoozed: '#snoozed',
      important: '#imp',
    };

    const hash = viewMap[params.view.toLowerCase()] ?? (params.view.startsWith('#') ? params.view : `#${params.view}`);

    window.location.hash = hash;

    return {
      navigated: true,
      current_view: window.location.hash,
    };
  },
});
