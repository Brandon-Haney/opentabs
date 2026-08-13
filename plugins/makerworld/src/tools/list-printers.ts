import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { declaredPrinters, PRINTERS } from '../printers.js';

export const listPrinters = defineTool({
  name: 'list_printers',
  displayName: 'List Printers',
  description:
    'List the Bambu Lab printers MakerWorld checks compatibility against, with the device code that identifies each one in the API and the product name people recognise — N1 is the A1 mini, C12 is the P1S. Also reports which printers the account owner declared support for in plugin settings, which is what set_printer_compatibility narrows to when called without an explicit list and what get_print_profiles measures a profile against. Call this to get valid printer names before set_printer_compatibility, or to translate a device code appearing in raw API output. Costs no request — the mapping is carried in the plugin, because MakerWorld publishes it only on the profile editor page, and loading that page forks a draft.',
  summary: 'Printer names, device codes, and the set you support',
  icon: 'printer',
  group: 'Reference',
  input: z.object({}),
  output: z.object({
    printers: z
      .array(
        z.object({
          code: z.string().describe('Device code used in API payloads, e.g. "N1"'),
          name: z.string().describe('Product name used everywhere else, e.g. "A1 mini"'),
          declared: z.boolean().describe('Whether the account owner listed this printer in plugin settings'),
        }),
      )
      .describe('Printers MakerWorld derives compatibility for'),
    your_printers: z
      .array(z.string())
      .describe('Printers declared in the "printers" setting. Empty when unset, which no tool treats as an error.'),
    unrecognised_settings: z
      .array(z.string())
      .describe('Entries in the "printers" setting matching no known printer — almost always a typo'),
  }),
  handle: async () => {
    const declared = declaredPrinters();
    const declaredSet = new Set(declared.names);

    return {
      printers: PRINTERS.map(printer => ({
        code: printer.code,
        name: printer.name,
        declared: declaredSet.has(printer.name),
      })),
      your_printers: declared.names,
      unrecognised_settings: declared.unrecognised,
    };
  },
});
