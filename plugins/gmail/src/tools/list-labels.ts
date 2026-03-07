import { formatLabelName, gmailSync, parseLabelCountsFromSync } from '../gmail-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { labelCountSchema } from './schemas.js';

export const listLabels = defineTool({
  name: 'list_labels',
  displayName: 'List Labels',
  description:
    'List Gmail labels with unread and total message counts via the sync API. ' +
    'Includes system labels (Inbox, Sent, Drafts, Trash, Spam, Starred) and category labels ' +
    '(Personal, Social, Promotions, Updates).',
  summary: 'List Gmail labels and their message counts',
  icon: 'tag',
  group: 'Labels',
  input: z.object({}),
  output: z.object({
    labels: z.array(labelCountSchema).describe('List of Gmail labels with counts'),
    count: z.number().describe('Number of labels'),
  }),
  handle: async () => {
    // Sync poll returns label counts in the response
    const resp = await gmailSync([null, null, [1, 0, null, null, [null, 0], null, 1], null, 2], { rt: 'r', pt: 'ji' });

    const labelCounts = parseLabelCountsFromSync(resp);

    return {
      labels: labelCounts.map(lc => ({
        label: formatLabelName(lc.label),
        raw_label: lc.label,
        unread: lc.unread,
        total: lc.total,
      })),
      count: labelCounts.length,
    };
  },
});
