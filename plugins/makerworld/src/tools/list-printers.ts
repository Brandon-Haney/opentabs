import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { ownedPrinters, PRINTERS } from '../printers.js';

export const listPrinters = defineTool({
  name: 'list_printers',
  displayName: 'List Printers',
  description:
    'List the Bambu Lab printers MakerWorld checks compatibility against, with the device code that identifies each one in the API and the product name people recognise — N1 is the A1 mini, C12 is the P1S. Also flags which of them the account owner actually has, per the owned_printers setting, which is what get_print_profiles measures cannot_test_on against. Owning a printer has no bearing on which printers a model is published for: a design goes to every printer whose plate it fits. Call this to get valid printer names before set_printer_compatibility, or to translate a device code appearing in raw API output. Costs no request — the mapping is carried in the plugin, because MakerWorld publishes it only on the profile editor page, and loading that page forks a draft.',
  summary: 'Printer names, device codes, and which you own',
  icon: 'printer',
  group: 'Reference',
  input: z.object({}),
  output: z.object({
    printers: z
      .array(
        z.object({
          code: z.string().describe('Device code used in API payloads, e.g. "N1"'),
          name: z.string().describe('Product name used everywhere else, e.g. "A1 mini"'),
          owned: z.boolean().describe('Whether the account owner has this printer, per the owned_printers setting'),
        }),
      )
      .describe('Printers MakerWorld derives compatibility for'),
    your_printers: z
      .array(z.string())
      .describe('Printers named in the owned_printers setting. Empty when unset, which no tool treats as an error.'),
    unrecognised_settings: z
      .array(z.string())
      .describe('Entries in owned_printers matching no known printer — almost always a typo'),
  }),
  handle: async () => {
    const owned = ownedPrinters();
    const ownedSet = new Set(owned.names);

    return {
      printers: PRINTERS.map(printer => ({
        code: printer.code,
        name: printer.name,
        owned: ownedSet.has(printer.name),
      })),
      your_printers: owned.names,
      unrecognised_settings: owned.unrecognised,
    };
  },
});
