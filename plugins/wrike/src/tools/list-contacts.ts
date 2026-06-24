import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

interface RawContact {
  uid?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  jobTitle?: string | null;
  isGroup?: boolean;
  deleted?: boolean;
  external?: boolean;
}

export const listContacts = defineTool({
  name: 'list_contacts',
  displayName: 'List Contacts',
  description:
    'List people and groups in the Wrike account, or search them by name or email. With no query, returns the account directory (up to the limit). With a query, returns matching contacts. Use this to resolve a person to their contact id (for example, before filtering tasks by assignee).',
  summary: 'List or search account contacts',
  icon: 'users',
  group: 'Account',
  input: z.object({
    query: z.string().optional().describe('Name or email to search for. Omit to list the account directory.'),
    limit: z.number().int().min(1).max(1000).optional().describe('Maximum contacts to return (default 50, max 1000)'),
  }),
  output: z.object({
    contacts: z
      .array(
        z.object({
          id: z.string().describe('Contact id (use as assignee/author id)'),
          name: z.string().describe('Full display name'),
          email: z.string().describe('Email address, or empty'),
          job_title: z.string().describe('Job title, or empty'),
          is_group: z.boolean().describe('True if this is a user group rather than an individual'),
          deleted: z.boolean().describe('True if the contact is deactivated'),
        }),
      )
      .describe('Matching contacts'),
    count: z.number().int().describe('Number of contacts returned'),
  }),
  handle: async params => {
    const data = await rpc<RawContact[]>('search_users', {
      text: [params.query ?? ''],
      limit: params.limit ?? 50,
      fetchLimit: 1000,
    });

    const contacts = (data ?? [])
      .map(contact => ({
        id: contact.uid ?? '',
        name: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
        email: contact.email ?? '',
        job_title: contact.jobTitle ?? '',
        is_group: contact.isGroup ?? false,
        deleted: contact.deleted ?? false,
      }))
      // Drop placeholder guest/bot entries that carry neither a name nor an email.
      .filter(contact => contact.name !== '' || contact.email !== '');

    return { contacts, count: contacts.length };
  },
});
