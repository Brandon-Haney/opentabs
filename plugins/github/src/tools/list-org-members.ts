import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';

export const listOrgMembers = defineTool({
  name: 'list_org_members',
  displayName: 'List Organization Members',
  description: 'List public members of a GitHub organization.',
  icon: 'users',
  input: z.object({
    org: z.string().min(1).describe('Organization name'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
    page: z.number().int().min(1).optional().describe('Page number (default 1)'),
  }),
  output: z.object({
    members: z
      .array(
        z.object({
          login: z.string().describe('Username'),
          id: z.number().describe('User ID'),
          avatar_url: z.string().describe('Avatar URL'),
          html_url: z.string().describe('Profile URL'),
        }),
      )
      .describe('List of organization members'),
  }),
  handle: async params => {
    const query: Record<string, string | number | boolean | undefined> = {
      per_page: params.per_page ?? 30,
      page: params.page,
    };

    const data = await api<{ login?: string; id?: number; avatar_url?: string; html_url?: string }[]>(
      `/orgs/${params.org}/members`,
      { query },
    );
    return {
      members: (data ?? []).map(m => ({
        login: m.login ?? '',
        id: m.id ?? 0,
        avatar_url: m.avatar_url ?? '',
        html_url: m.html_url ?? '',
      })),
    };
  },
});
