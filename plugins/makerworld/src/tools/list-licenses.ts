import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';

interface RawLicense {
  license?: string;
  licenseDescriptionInfo?: { title?: string; content?: string };
}

interface RawLicenseList {
  list?: RawLicense[];
}

export const listLicenses = defineTool({
  name: 'list_licenses',
  displayName: 'List Licenses',
  description:
    'List the licenses a model can be published under. Call this to get a valid license identifier before upload_model or update_profile, rather than guessing at license codes.',
  summary: 'List licenses available for models',
  icon: 'scale',
  group: 'Reference',
  input: z.object({}),
  output: z.object({
    licenses: z
      .array(
        z.object({
          id: z.string().describe('License identifier to pass to other tools (e.g., "BY-NC", "CC0")'),
          description: z.string().describe('What the license permits, empty when MakerWorld provides no text'),
        }),
      )
      .describe('Available licenses'),
  }),
  handle: async () => {
    const data = await api<RawLicenseList>('design-service', '/design/license');

    return {
      licenses: (data.list ?? []).map(l => ({
        id: l.license ?? '',
        description: l.licenseDescriptionInfo?.content ?? '',
      })),
    };
  },
});
