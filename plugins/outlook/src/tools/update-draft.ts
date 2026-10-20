import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachToDraft, inlineImagesField, referencedContentIds, validateInlineImages } from '../attachments.js';
import { deleteInlineImages, extractQuotedThread, listInlineImages, requireDraft } from '../drafts.js';
import { composeWithMentions, MENTION_HELP, resolvePeople, unaddressedMentions } from '../mentions.js';
import { api } from '../outlook-api.js';
import { emailAddressSchema, mapEmailAddress, type RawEmailAddress } from './schemas.js';

const toRecipients = (addresses: string[]) => addresses.map(address => ({ emailAddress: { address } }));

export const updateDraft = defineTool({
  name: 'update_draft',
  displayName: 'Update Draft',
  description:
    'Edit an unsent draft in place: its subject, body, To/CC/BCC recipients, or importance. Only the fields you pass ' +
    'change, and a recipient list you pass replaces that whole list. A new body replaces the text you wrote, with ' +
    "the user's default font and signature applied as create_draft does; on a reply or forward draft the quoted " +
    'thread below it is kept. With a new body, inline images it no longer shows are removed and inline_images adds ' +
    'new ones; an HTML body may keep showing images already on the draft by their cid. The call is refused unless ' +
    'the message is still a draft. Other attachments are unchanged (use add_attachment).',
  summary: 'Edit an unsent draft',
  icon: 'file-pen',
  group: 'Messages',
  input: z.object({
    draft_id: z.string().min(1).describe('ID of the draft to edit (draft_id from the tool that created it)'),
    subject: z.string().optional().describe('New subject'),
    body: z
      .string()
      .optional()
      .describe(`New body, replacing the text written above any quoted thread. ${MENTION_HELP}`),
    body_type: z.enum(['text', 'html']).optional().describe('Body content type (default: text)'),
    include_signature: z.boolean().optional().describe("Append the user's signature to the new body (default: true)"),
    to: z.array(z.string()).optional().describe('Replacement To recipient email addresses'),
    cc: z.array(z.string()).optional().describe('Replacement CC recipient email addresses'),
    bcc: z.array(z.string()).optional().describe('Replacement BCC recipient email addresses'),
    importance: z.enum(['low', 'normal', 'high']).optional().describe('Importance level'),
    inline_images: inlineImagesField,
  }),
  output: z.object({
    subject: z.string().describe('Subject of the draft after the edit'),
    to: z.array(emailAddressSchema).describe('To recipients after the edit'),
    web_link: z.string().describe('Link to open the draft in Outlook'),
  }),
  handle: async (params, context) => {
    const { draft_id, subject, body, to, cc, bcc, importance, inline_images } = params;
    if ([subject, body, to, cc, bcc, importance].every(field => field === undefined)) {
      throw ToolError.validation('Pass at least one field to change: subject, body, to, cc, bcc, or importance.');
    }
    if (inline_images?.length && body === undefined) {
      throw ToolError.validation('inline_images go with a new body: pass body (with body_type "html") as well.');
    }

    const draft = await requireDraft(
      draft_id,
      'edited',
      body === undefined ? [] : ['body', 'toRecipients', 'ccRecipients', 'bccRecipients'],
    );
    const existingImages = body === undefined ? [] : await listInlineImages(draft_id);
    if (body !== undefined) {
      validateInlineImages(
        body,
        params.body_type,
        inline_images,
        new Set(existingImages.map(image => image.contentId)),
      );
    }

    const changes: Record<string, unknown> = {};
    if (subject !== undefined) changes.subject = subject;
    if (importance !== undefined) changes.importance = importance;
    if (to !== undefined) changes.toRecipients = toRecipients(to);
    if (cc !== undefined) changes.ccRecipients = toRecipients(cc);
    if (bcc !== undefined) changes.bccRecipients = toRecipients(bcc);
    let newContent: string | undefined;
    if (body !== undefined) {
      const quotedThread = extractQuotedThread(draft.body?.content ?? '');
      // Recipients as they will stand after this edit: a list passed here replaces the draft's.
      const toAfter: (string | RawEmailAddress)[] = to ?? draft.toRecipients ?? [];
      const recipients = [...toAfter, ...(cc ?? draft.ccRecipients ?? []), ...(bcc ?? draft.bccRecipients ?? [])];
      const composed = await composeWithMentions(
        { body, body_type: params.body_type, include_signature: params.include_signature },
        quotedThread ? 'reply' : 'new',
        () => resolvePeople(recipients),
      );
      newContent = `${composed.body.content}${quotedThread ?? ''}`;
      changes.body = { contentType: 'HTML', content: newContent };
      const added = unaddressedMentions(composed.mentioned, recipients);
      if (added.length > 0) {
        changes.toRecipients = [
          ...toAfter.map(r => (typeof r === 'string' ? { emailAddress: { address: r } } : r)),
          ...added.map(person => ({ emailAddress: { address: person.address, name: person.name } })),
        ];
      }
    }

    const updated = await api<{ subject?: string; toRecipients?: RawEmailAddress[]; webLink?: string }>(
      `/me/messages/${draft_id}`,
      { method: 'PATCH', body: changes },
    );

    if (newContent !== undefined) {
      // Inline images the new body no longer shows, or that inline_images replaces,
      // would otherwise linger on the draft as stray attachments.
      const shown = referencedContentIds(newContent);
      const replaced = new Set(inline_images?.map(image => image.content_id));
      await deleteInlineImages(
        draft_id,
        existingImages.filter(image => !shown.has(image.contentId) || replaced.has(image.contentId)),
      );
      await attachToDraft(draft_id, { inline_images }, context);
    }
    return {
      subject: updated.subject ?? '',
      to: (updated.toRecipients ?? []).map(mapEmailAddress),
      web_link: updated.webLink ?? '',
    };
  },
});
