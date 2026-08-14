import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { readLayoutSlots, roleForPlaceholderType } from '../placeholders.js';
import { downloadPptx, getRelatedParts, getSlideList, TEXT_DECODER } from '../pptx-utils.js';
import { childByLocalName, parseXml } from '../xml.js';
import { driveIdInput } from './schemas.js';

/** The layout's author-facing name and its `type` hint, e.g. "Title and Content" / "obj". */
const readLayoutIdentity = (layoutXml: string): { name: string | null; type: string | null } => {
  const root = parseXml(layoutXml).documentElement;
  const cSld = root ? childByLocalName(root, 'cSld') : undefined;
  return {
    name: cSld?.getAttribute('name') || null,
    type: root?.getAttribute('type') || null,
  };
};

export const listSlideLayouts = defineTool({
  name: 'list_slide_layouts',
  displayName: 'List Slide Layouts',
  description:
    'List the slide layouts this presentation offers, with the named slots each one provides. Use it to choose a ' +
    '`layout_part` for `add_slide` — a layout determines which slots a new slide will have and where they sit, so ' +
    'picking the right one is what makes a new slide match the deck. `in_use_by` shows which existing slides already ' +
    'use each layout, which is usually the fastest way to identify the one you want.',
  summary: 'List the layouts available for new slides',
  icon: 'layout-dashboard',
  group: 'Slides',
  input: z.object({
    item_id: z.string().describe('Item ID of the PowerPoint file'),
    drive_id: driveIdInput,
  }),
  output: z.object({
    layouts: z
      .array(
        z.object({
          part: z.string().describe('Package path to pass to `add_slide` as `layout_part`'),
          name: z.string().nullable().describe('Layout name as PowerPoint shows it, e.g. "Title and Content"'),
          type: z.string().nullable().describe('Layout type hint from the schema, e.g. "obj", "titleOnly", "blank"'),
          slots: z
            .array(z.object({ role: z.string(), idx: z.number().int() }))
            .describe('Named slots a slide built from this layout will have'),
          in_use_by: z.array(z.number().int()).describe('Slide numbers (1-indexed) currently using this layout'),
        }),
      )
      .describe('Layouts defined by the presentation, in package order'),
  }),
  handle: async params => {
    const entries = await downloadPptx(params.item_id, params.drive_id);

    // Count usage from the slides rather than the layouts: the relationship
    // runs slide → layout, and a layout can be defined but used by nothing.
    const usageByPart = new Map<string, number[]>();
    getSlideList(entries).forEach((slideFile, i) => {
      const layoutPart = getRelatedParts(entries, slideFile, '/slideLayout')[0];
      if (!layoutPart) return;
      const slides = usageByPart.get(layoutPart) ?? [];
      slides.push(i + 1);
      usageByPart.set(layoutPart, slides);
    });

    const layouts = Array.from(entries.keys())
      .filter(part => /^ppt\/slideLayouts\/[\w.-]+\.xml$/.test(part))
      .sort()
      .map(part => {
        const xml = TEXT_DECODER.decode(entries.get(part) ?? new Uint8Array());
        const { name, type } = readLayoutIdentity(xml);
        return {
          part,
          name,
          type,
          slots: readLayoutSlots(xml).flatMap(spec => {
            const role = roleForPlaceholderType(spec.type);
            return role ? [{ role, idx: spec.idx }] : [];
          }),
          in_use_by: usageByPart.get(part) ?? [],
        };
      });

    return { layouts };
  },
});
