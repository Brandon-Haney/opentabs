import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';

interface RawSuggestion {
  text?: string;
  count?: number;
}

export const suggestTags = defineTool({
  name: 'suggest_tags',
  displayName: 'Suggest Tags',
  description:
    'Look up the tags MakerWorld already knows for a keyword, with the number of models carrying each one. This is the autocomplete the upload form itself uses, so it reports real catalogue usage rather than a guess — which turns choosing tags from an opinion into something checkable. A tag with thousands of models is a crowded search; one with a handful may be too obscure to bring traffic. Use it before update_model to confirm a proposed tag is spelled the way the site spells it and is one people actually browse.',
  summary: 'Look up real tags and how many models use them',
  icon: 'tags',
  group: 'Models',
  input: z.object({
    keyword: z.string().min(1).describe('Word or phrase to find tags for'),
  }),
  output: z.object({
    suggestions: z
      .array(
        z.object({
          tag: z.string().describe('Tag exactly as MakerWorld stores it'),
          model_count: z.number().describe('Models currently carrying this tag'),
        }),
      )
      .describe('Matching tags, most relevant first'),
    count: z.number().describe('Number of suggestions returned'),
  }),
  handle: async params => {
    const data = await api<{ suggestions?: RawSuggestion[] }>('search-service', '/suggest', {
      query: { keyword: params.keyword, type: 'design_tag' },
    });

    const suggestions = (data.suggestions ?? []).map(suggestion => ({
      tag: suggestion.text ?? '',
      model_count: suggestion.count ?? 0,
    }));
    return { suggestions, count: suggestions.length };
  },
});
