import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { printProfileDetailSchema, type RawDesignWithInstances } from './schemas.js';

/**
 * Printers MakerWorld's compatibility checker covers, as of the last time the
 * profile editor was observed serving its fleet list.
 *
 * The authoritative list lives on the profile editor's page props, but fetching
 * that page forks a draft server-side, so a read-only tool cannot use it. This
 * baseline stands in, and every printer already present on a profile is unioned
 * in on top — so a name missing here can only ever cause an under-report, never
 * a phantom "unsupported" entry. set_printer_compatibility, which has to write
 * anyway, reads the live fleet and validates against that instead.
 */
const KNOWN_PRINTERS = [
  'A1',
  'A1 mini',
  'A2L',
  'H2C',
  'H2D',
  'H2D Pro',
  'H2S',
  'P1P',
  'P1S',
  'P2S',
  'X1',
  'X1 Carbon',
  'X1E',
  'X2D',
];

/** MakerWorld reports estimated print time in seconds. */
const SECONDS_PER_MINUTE = 60;

export const getPrintProfiles = defineTool({
  name: 'get_print_profiles',
  displayName: 'Get Print Profiles',
  description:
    'Inspect the print profiles attached to a model: which printers each one supports, which it does not, nozzle size, estimated print time, filament weight, plate count, whether an AMS is needed, and how each profile has been received. Printer compatibility is the detail worth checking first — a profile only lists the printers it was sliced against when it was uploaded, so a model published before a printer existed silently excludes everyone who owns one, and no metric reveals it. The same properties explain weak conversion generally: supports, long prints, multiple plates, and AMS requirements all cost prints from people who viewed the page. Complements list_profile_stats, which reports what a profile earned rather than what it is.',
  summary: 'Printer compatibility and print settings for a model',
  icon: 'printer',
  group: 'Models',
  input: z.object({
    design_id: z.number().int().describe('Model ID'),
  }),
  output: z.object({
    design_id: z.number().describe('Model the profiles belong to'),
    title: z.string().describe('Model title'),
    profiles: z.array(printProfileDetailSchema).describe('Print profiles attached to the model'),
    count: z.number().describe('Number of profiles'),
  }),
  handle: async params => {
    const design = await api<RawDesignWithInstances>('design-service', `/design/${params.design_id}`);

    const profiles = (design.instances ?? []).map(instance => {
      const modelInfo = instance.extention?.modelInfo ?? {};
      const primary = modelInfo.compatibility?.devProductName ?? '';
      const others = (modelInfo.otherCompatibility ?? [])
        .map(printer => printer.devProductName ?? '')
        .filter(name => name.length > 0);

      const supported = [...new Set([primary, ...others].filter(name => name.length > 0))].sort();
      const fleet = new Set([...KNOWN_PRINTERS, ...supported]);
      const unsupported = [...fleet].filter(printer => !supported.includes(printer)).sort();

      const ratingCount = instance.ratingCount ?? 0;
      const printSeconds = instance.prediction ?? 0;

      return {
        instance_id: instance.id ?? 0,
        title: instance.title ?? '',
        supported_printers: supported,
        unsupported_printers: unsupported,
        nozzle_mm: modelInfo.compatibility?.nozzleDiameter ?? 0,
        print_time_minutes: Math.round(printSeconds / SECONDS_PER_MINUTE),
        filament_grams: instance.weight ?? 0,
        plate_count: (modelInfo.plates ?? []).length,
        needs_ams: instance.needAms ?? false,
        prints: instance.printCount ?? 0,
        downloads: instance.downloadCount ?? 0,
        rating_count: ratingCount,
        average_rating: ratingCount > 0 ? Math.round(((instance.ratingScoreTotal ?? 0) / ratingCount) * 100) / 100 : 0,
      };
    });

    return {
      design_id: params.design_id,
      title: design.title ?? '',
      profiles,
      count: profiles.length,
    };
  },
});
