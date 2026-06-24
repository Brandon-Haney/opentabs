import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';

interface SidebarInitialData {
  user?: {
    uid?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    jobTitle?: string | null;
  };
  account?: {
    id?: number | string;
    accountName?: string;
  };
  personalSpaceId?: number | string;
}

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the currently logged-in Wrike user and their account: contact id, name, email, job title, the account id and name, and the personal space id. Use the contact id to recognise yourself in assignee and author fields.',
  summary: 'Get the logged-in user and account',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    id: z.string().describe('Your Wrike contact id'),
    name: z.string().describe('Your full display name'),
    first_name: z.string().describe('First name'),
    last_name: z.string().describe('Last name'),
    email: z.string().describe('Email address'),
    job_title: z.string().describe('Job title, or empty if not set'),
    account_id: z.string().describe('The active Wrike account id'),
    account_name: z.string().describe('The active account name'),
    personal_space_id: z.string().describe('Id of your personal space, or empty'),
  }),
  handle: async () => {
    const data = await rpc<SidebarInitialData>('get_sidebar_initial_data', {});
    const user = data.user ?? {};
    const account = data.account ?? {};
    return {
      id: user.uid ?? '',
      name: [user.firstName, user.lastName].filter(Boolean).join(' '),
      first_name: user.firstName ?? '',
      last_name: user.lastName ?? '',
      email: user.email ?? '',
      job_title: user.jobTitle ?? '',
      account_id: account.id !== undefined && account.id !== null ? String(account.id) : '',
      account_name: account.accountName ?? '',
      personal_space_id:
        data.personalSpaceId !== undefined && data.personalSpaceId !== null ? String(data.personalSpaceId) : '',
    };
  },
});
