import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, getLogin } from '../github-api.js';
import { mapUser, userSchema } from './schemas.js';

export const getUserProfile = defineTool({
  name: 'get_user_profile',
  displayName: 'Get User Profile',
  description: "Get a GitHub user's profile. Defaults to the authenticated user if no username is provided.",
  icon: 'user',
  input: z.object({
    username: z.string().optional().describe('GitHub username — defaults to the authenticated user'),
  }),
  output: z.object({
    user: userSchema.describe('User profile'),
  }),
  handle: async params => {
    const username = params.username ?? getLogin();
    const data = await api<Record<string, unknown>>(`/users/${username}`);
    return { user: mapUser(data) };
  },
});
