import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsReadOutline, podsReadOutlineOutputSchema } from '../pods-bridge.js';

export const getLiveOutline = defineTool({
  name: 'get_live_outline',
  displayName: 'Get Live Outline',
  description:
    'Read the LIVE state of the deck that is OPEN in the browser: the current slide list, every paragraph with its ' +
    'per-run formatting (size, bold, italic, underline, color, font), and the shape names. Unlike `get_slides` and ' +
    'the other file-based reads — which see the last SAVED version — this reads the co-authoring session itself, so ' +
    'it reflects edits made seconds ago, including by other people. Use it to see the deck as it is on screen, to ' +
    'pick exact `text` targets for `format_text`/`set_font_size`, and to verify a live edit landed. The deck must be ' +
    'open and active in the browser.',
  summary: 'Read the open deck’s live text, formatting, and structure',
  icon: 'eye',
  group: 'Slides',
  input: z.object({}),
  output: podsReadOutlineOutputSchema,
  handle: async () => podsReadOutline(),
});
