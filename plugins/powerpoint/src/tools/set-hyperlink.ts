import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsSetHyperlink, podsSetHyperlinkOutputSchema } from '../pods-bridge.js';

export const setHyperlink = defineTool({
  name: 'set_hyperlink',
  displayName: 'Set Hyperlink',
  description:
    'Turn text on the open slide into a hyperlink, or strip one with `remove`. Name the paragraph with `text` and ' +
    'narrow the link with `match`, the way a person selects words and presses Ctrl+K; without `match` the whole ' +
    'paragraph becomes the link. The words keep their formatting. A paragraph can hold several links: words beside ' +
    'an existing link can be linked, words overlapping one are refused. `text` includes each existing link’s hidden ' +
    '`HYPERLINK "…"` code (as `get_live_outline` shows it), so a word that also appears in a link’s address matches ' +
    'there first — use `occurrence` to reach the visible one. Writes land in the live co-authoring session within ' +
    'seconds, and the editor’s Undo cannot take them back, which is why `remove` exists. The deck must be open and ' +
    'active in the browser.',
  summary: 'Link text on the open slide to a URL',
  icon: 'link',
  group: 'Slides',
  input: z.object({
    text: z
      .string()
      .min(1)
      .describe(
        'The exact text of the paragraph holding the words, e.g. a bullet or a slide title, as `get_live_outline` shows it (including any existing link’s hidden code).',
      ),
    match: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Link only this part of the paragraph — a substring of `text`, e.g. "the SOP" to link two words of a sentence. Omit to link the whole paragraph. With `remove`, the words of the link to take off.',
      ),
    occurrence: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Which occurrence of `match` to link when it appears more than once, counting from 1. Defaults to the first.',
      ),
    url: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The address to link to — an http:// or https:// URL, or a mailto: address. It may not contain a double quote. Required unless `remove` is true.',
      ),
    remove: z
      .boolean()
      .optional()
      .describe(
        'Strip a link instead of adding one: the one `match` falls in, or the paragraph’s only link when `match` is omitted. The words stay, keeping their formatting; `url` is not needed.',
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe('When true, construct and return the revision without writing it, so the change can be checked first.'),
  }),
  output: podsSetHyperlinkOutputSchema,
  handle: async params =>
    podsSetHyperlink(
      params.text,
      params.url,
      { match: params.match, occurrence: params.occurrence },
      params.dry_run ?? false,
      params.remove ?? false,
    ),
});
