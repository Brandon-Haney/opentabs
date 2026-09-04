import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsSetHyperlink, podsSetHyperlinkOutputSchema } from '../pods-bridge.js';

export const setHyperlink = defineTool({
  name: 'set_hyperlink',
  displayName: 'Set Hyperlink',
  description:
    'Turn text on the open slide into a hyperlink, or strip a link it already has with `remove`. Name the paragraph with `text`, and narrow the link to part of ' +
    'it with `match` — the way a person selects a few words and presses Ctrl+K; without `match` the whole ' +
    'paragraph becomes the link. The linked words keep the formatting they already had. This writes into the live ' +
    'co-authoring session, so the link appears in the open editor within a few seconds; it edits the deck in place ' +
    'while it is open (Graph refuses writes under the co-authoring lock). Use `get_live_outline` to see the exact ' +
    'paragraph text. Adding a link to text that already contains one is not supported — the tool refuses rather ' +
    'than corrupting the paragraph — pass `remove: true` first to take the existing link off. Removing matters because ' +
    'these edits arrive as a co-author’s, so the editor’s own Undo cannot take them back. The deck must be open and ' +
    'active in the browser.',
  summary: 'Link text on the open slide to a URL',
  icon: 'link',
  group: 'Slides',
  input: z.object({
    text: z
      .string()
      .min(1)
      .describe('The exact visible text of the paragraph holding the words to link, e.g. a bullet or a slide title.'),
    match: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Link only this part of the paragraph — a substring of `text`, e.g. "the SOP" to link two words of a sentence. Omit to link the whole paragraph.',
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
        'Strip the link the paragraph already carries instead of adding one. The words stay, keeping their formatting; `match` and `url` are not needed.',
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
