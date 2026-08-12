import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchFullProfile } from '../makerworld-api.js';
import { mapUserProfile, type RawUserProfile, userProfileSchema } from './schemas.js';

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the signed-in account: handle, display name, bio, avatar, follower and following counts, lifetime like/collect/download totals, listed printer models, and profile links. Use this to read the profile before changing it with update_profile.',
  summary: 'Get the signed-in account profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({ user: userProfileSchema.describe('The signed-in account') }),
  handle: async () => {
    const data = await fetchFullProfile<RawUserProfile & Record<string, unknown>>();
    return { user: mapUserProfile(data) };
  },
});
