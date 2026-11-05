import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { isEmailMention } from '../chat-mentions.js';
import { orgMri } from '../people.js';
import { ensureGraphToken } from '../reported-step.js';
import { type DirectoryPerson, findDirectoryUsersByEmail, searchDirectory } from '../teams-api.js';

const personSchema = z.object({
  name: z.string().describe('Display name'),
  email: z
    .string()
    .nullable()
    .describe('Mailbox address, or null for an account without one (often an admin or service account)'),
  sign_in_name: z.string().describe('Sign-in name (user principal name)'),
  mri: z.string().describe('Teams MRI, for create_chat, add_member and remove_member'),
  job_title: z.string().nullable().describe('Job title, when the directory lists one'),
  department: z.string().nullable().describe('Department, when the directory lists one'),
});

export const findPeople = defineTool({
  name: 'find_people',
  displayName: 'Find People',
  description:
    "Look up people in your organization's directory by name or email address, including people you have never " +
    'chatted with. Returns each match’s name, email address and Teams MRI, which create_chat, add_member and ' +
    'remove_member take (they also take the email address). An email address returns that one person; a name ' +
    'returns everyone whose name or email has words starting with its words, people with a mailbox first. One ' +
    'person can have several accounts: the one with a mailbox is the one they chat from. Check the job title and ' +
    'department when a name matches more than one person. Work or school Teams only.',
  summary: 'Look up people by name or email',
  icon: 'search',
  group: 'People',
  input: z.object({
    query: z.string().trim().min(1).describe('A name, part of a name, or an email address, e.g. "Gary Winko"'),
    limit: z.number().int().min(1).max(25).optional().describe('Most people to return (default 10, max 25)'),
  }),
  output: z.object({
    people: z.array(personSchema).describe('The people found'),
  }),
  handle: async (params, context) => {
    await ensureGraphToken(context);
    const found: DirectoryPerson[] = isEmailMention(params.query)
      ? await findDirectoryUsersByEmail([params.query])
      : await searchDirectory(params.query, params.limit ?? 10);
    // A stable sort: the directory's order holds within each group.
    const withMailboxFirst = [...found].sort((a, b) => Number(!a.mail) - Number(!b.mail));
    return {
      people: withMailboxFirst.map(person => ({
        name: person.displayName,
        email: person.mail,
        sign_in_name: person.userPrincipalName,
        mri: orgMri(person.id),
        job_title: person.jobTitle ?? null,
        department: person.department ?? null,
      })),
    };
  },
});
