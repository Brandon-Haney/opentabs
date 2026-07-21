import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { setTaskDescription } from '../live-editor.js';

export const setDescription = defineTool({
  name: 'set_description',
  displayName: 'Set Description',
  description:
    "Replace a task's description, written in Markdown. Wrike descriptions are a collaborative document, so this writes through the live editor. Supported inline formatting: **bold**, *italic*, ~~strikethrough~~, `inline code`, [links](https://example.com), and <u>underline</u>. Line breaks are preserved. Block formatting (headings, lists, code blocks) is not yet supported. This replaces the entire description; read the current one with get_task first if you need to preserve part of it. Pass an empty string to clear the description.",
  summary: "Set a task's description (Markdown)",
  icon: 'text',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id'),
    description: z
      .string()
      .describe(
        'The new description in Markdown. Inline formatting is supported; line breaks are kept; pass "" to clear it.',
      ),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the description was updated'),
  }),
  handle: async params => {
    await setTaskDescription(Number(params.task_id), params.description);
    return { success: true };
  },
});
