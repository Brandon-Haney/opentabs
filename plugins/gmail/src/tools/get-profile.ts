import { getUserEmail, getBasePath } from '../gmail-api.js';
import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const getProfile = defineTool({
  name: 'get_profile',
  displayName: 'Get Profile',
  description:
    'Get the current Gmail user profile including email address and account path. ' +
    'Useful for confirming which account is active when multiple Google accounts are signed in.',
  summary: 'Get the current Gmail user profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    email: z.string().describe('The email address of the logged-in Gmail user'),
    base_path: z.string().describe('The Gmail base path (e.g., "/mail/u/0" for the primary account)'),
    account_index: z.string().describe('The account index (e.g., "0" for primary, "1" for secondary)'),
  }),
  handle: async () => {
    const email = getUserEmail();
    const basePath = getBasePath();
    const match = basePath.match(/\/mail\/u\/(\d+)/);
    const accountIndex = match?.[1] ?? '0';

    return {
      email,
      base_path: basePath,
      account_index: accountIndex,
    };
  },
});
