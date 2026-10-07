import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { requireDraft } from '../drafts.js';
import { api } from '../outlook-api.js';
import { emailAddressSchema, mapEmailAddress } from './schemas.js';

export const deleteDraft = defineTool({
  name: 'delete_draft',
  displayName: 'Delete Draft',
  description:
    'Delete an unsent draft, such as one made by create_draft or by reply_to_message / forward_message with draft ' +
    'set to true. The message is checked first and the call is refused unless it is still a draft, so received or ' +
    'sent mail is never touched; use delete_message for those. The draft moves to Deleted Items. Returns the ' +
    'subject and recipients of the deleted draft — compare them with the draft you meant to delete.',
  summary: 'Delete an unsent draft',
  icon: 'file-x',
  group: 'Messages',
  input: z.object({
    draft_id: z.string().min(1).describe('ID of the draft to delete (draft_id from the tool that created it)'),
  }),
  output: z.object({
    subject: z.string().describe('Subject of the deleted draft'),
    to: z.array(emailAddressSchema).describe('To recipients of the deleted draft'),
  }),
  handle: async params => {
    const draft = await requireDraft(params.draft_id, 'deleted', ['toRecipients']);
    await api(`/me/messages/${params.draft_id}`, { method: 'DELETE' });
    return { subject: draft.subject ?? '', to: (draft.toRecipients ?? []).map(mapEmailAddress) };
  },
});
