import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { mapFeedbackEntry, modelFeedbackSchema, type RawFeedbackEntry } from './schemas.js';

interface RawFeedbackFeed {
  total?: number;
  hits?: RawFeedbackEntry[];
}

export const listModelFeedback = defineTool({
  name: 'list_model_feedback',
  displayName: 'List Model Feedback',
  description:
    'Read the comments and ratings left on a model, newest first. This is the only qualitative signal MakerWorld exposes and it answers two questions the metrics cannot: what people are asking you to build next, and why a model that gets plenty of views is not getting printed. Ratings carry a 1-5 score, whether the print succeeded, and — on low scores — the problem category the rater chose, such as a support or tolerance issue. Requests for variants usually appear in the replies. Works on any public model, so it also reads a competitor listing.',
  summary: 'Read comments and ratings on a model',
  icon: 'message-square',
  group: 'Analytics',
  input: z.object({
    design_id: z.number().int().describe('Model ID'),
    offset: z.number().int().min(0).optional().describe('Number of entries to skip (default 0)'),
    limit: z.number().int().min(1).max(50).optional().describe('Entries per page (default 20, max 50)'),
  }),
  output: z.object({
    feedback: z.array(modelFeedbackSchema).describe('Comments and ratings, newest first'),
    count: z.number().describe('Number of entries returned'),
    total: z.number().describe('Total entries available on this model'),
  }),
  handle: async params => {
    const data = await api<RawFeedbackFeed>('comment-service', '/commentandrating', {
      query: {
        designId: params.design_id,
        offset: params.offset ?? 0,
        limit: params.limit ?? 20,
      },
    });

    const feedback = (data.hits ?? []).map(mapFeedbackEntry);
    return { feedback, count: feedback.length, total: data.total ?? feedback.length };
  },
});
