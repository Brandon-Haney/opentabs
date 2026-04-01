import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getUserInfo, hasGraphAuth, isSharePoint, sharepointGetCurrentUser } from '../excel-api.js';
import { userSchema } from './schemas.js';

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the profile of the currently authenticated Microsoft 365 user including display name, email, and user ID.',
  summary: 'Get the authenticated user profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({ user: userSchema }),
  handle: async () => {
    if (isSharePoint() && !hasGraphAuth()) {
      const user = sharepointGetCurrentUser();
      return { user: { id: user.id, display_name: user.displayName, email: user.mail } };
    }
    const data = await getUserInfo();
    return {
      user: {
        id: data.id ?? '',
        display_name: data.displayName ?? '',
        email: data.mail ?? '',
      },
    };
  },
});
