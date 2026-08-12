import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, apiVoid, fetchFullProfile } from '../makerworld-api.js';
import { mapUserProfile, type RawUserProfile, userProfileSchema } from './schemas.js';

/**
 * The preferences endpoint stores the profile and every account setting in one
 * document and replaces it wholesale on write, so a partial PUT would silently
 * clear notification and privacy settings. Every update is therefore a
 * read-modify-write of the full document.
 */
interface RawPreferences extends RawUserProfile {
  [key: string]: unknown;
}

/** MakerWorld encodes its boolean settings as 0/1 integers, not JSON booleans. */
const toFlag = (value: boolean): number => (value ? 1 : 0);

export const updateProfile = defineTool({
  name: 'update_profile',
  displayName: 'Update Profile',
  description:
    'Update your public profile: bio, external links, listed printer models, pinned models, default license for new uploads, and profile privacy toggles. Only the fields you pass are changed — everything else, including notification settings, is preserved. Returns the updated profile. Use get_current_user first to see current values, and list_licenses for valid license identifiers.',
  summary: 'Update your public profile and privacy settings',
  icon: 'user-pen',
  group: 'Account',
  input: z.object({
    bio: z.string().optional().describe('Profile bio text'),
    links: z.array(z.string()).optional().describe('External links to list on the profile; replaces the existing set'),
    printer_models: z
      .array(z.string())
      .optional()
      .describe('Printer models to list on the profile (e.g., ["X1 Carbon"]); replaces the existing set'),
    pinned_design_ids: z
      .array(z.number().int())
      .optional()
      .describe('Model IDs to pin to the top of the profile; replaces the existing set'),
    default_license: z.string().optional().describe('License applied to new uploads by default, from list_licenses'),
    show_likes: z.boolean().optional().describe('Whether other users can see the models you have liked'),
    show_followers: z.boolean().optional().describe('Whether your follower list is public'),
    show_following: z.boolean().optional().describe('Whether the list of users you follow is public'),
    show_nsfw: z.boolean().optional().describe('Whether not-safe-for-work models are shown to you'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the profile was updated'),
    user: userProfileSchema.describe('The profile after the update'),
  }),
  handle: async params => {
    // Read the preferences document alone — it is the exact document the PUT
    // replaces, so merging in profile-only fields would send unknown keys back.
    const current = await api<RawPreferences>('design-user-service', '/my/preference');

    const updated: RawPreferences = { ...current };
    if (params.bio !== undefined) updated.bio = params.bio;
    if (params.links !== undefined) updated.links = params.links;
    if (params.printer_models !== undefined) updated.deviceNames = params.printer_models;
    if (params.pinned_design_ids !== undefined) updated.pinnedDesignIds = params.pinned_design_ids;
    if (params.default_license !== undefined) updated.defaultLicense = params.default_license;
    if (params.show_likes !== undefined) updated.isLikeOpen = toFlag(params.show_likes);
    if (params.show_followers !== undefined) updated.isFanOpen = toFlag(params.show_followers);
    if (params.show_following !== undefined) updated.isFollowOpen = toFlag(params.show_following);
    if (params.show_nsfw !== undefined) updated.isNSFWShown = toFlag(params.show_nsfw);

    await apiVoid('design-user-service', '/my/preference', { method: 'PUT', body: updated });

    const refreshed = await fetchFullProfile<RawUserProfile & Record<string, unknown>>();
    return { success: true, user: mapUserProfile(refreshed) };
  },
});
