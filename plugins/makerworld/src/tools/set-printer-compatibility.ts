import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiVoid, fetchPageData } from '../makerworld-api.js';
import { declaredPrinters, resolvePrinterName } from '../printers.js';
import type { RawProfileEditPage } from './schemas.js';

/**
 * Fields the profile editor adds on top of the draft the server returns,
 * reproduced exactly as the web client sends them. `mode` and `clickWhich`
 * mark this as an edit of an existing profile being sent for publication.
 */
const EDITOR_FIELDS: Record<string, unknown> = {
  mode: 'editProfile',
  clickWhich: 'publish',
  uploading3mfStatus: 2,
  accessoriesIsUploading: false,
  modelDetailIsUploading: false,
  picturesIsUploading: false,
  profilePicturesIsUploading: false,
  rawModelFileIsUploading: false,
  templateFileIsUploading: false,
  videosIsUploading: false,
};

const printerName = (machine: { devProductName?: string; name?: string }): string =>
  machine.devProductName ?? machine.name ?? '';

const printerCode = (machine: { devModelName?: string; model?: string }): string =>
  machine.devModelName ?? machine.model ?? '';

export const setPrinterCompatibility = defineTool({
  name: 'set_printer_compatibility',
  displayName: 'Set Printer Compatibility',
  description:
    'Choose which printers a print profile is offered for. This can only ever narrow the list, never widen it: MakerWorld derives the printers a profile can slice for from the 3MF itself, and that derived set is a hard ceiling — asking for a printer outside it changes nothing, and the tool reports it as unavailable rather than pretending to have enabled it. Restoring a printer that is missing from the derived set requires re-slicing the model and replacing the file, which no tool can do. Use it to withdraw a printer that technically slices but produces poor results. Call get_print_profiles first for the instance ID and the current list.',
  summary: 'Narrow which printers a print profile is offered for',
  icon: 'printer',
  group: 'Models',
  input: z.object({
    instance_id: z.number().int().describe('Print profile ID, from get_print_profiles'),
    supported_printers: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Printers the profile should be offered for, by product name such as "X1 Carbon" or "P1S". Anything derived but absent from this list is withdrawn. The profile\'s primary printer is always kept and does not need listing. Omit to use the printers the account owner declared in plugin settings.',
      ),
  }),
  output: z.object({
    instance_id: z.number().describe('Print profile that was changed'),
    primary_printer: z.string().describe("The profile's primary printer, which is always kept"),
    derived_printers: z
      .array(z.string())
      .describe('Everything MakerWorld derived from the 3MF — the ceiling on what can be offered'),
    will_publish: z.array(z.string()).describe('Printers the profile will be offered for once review clears'),
    withdrawn: z.array(z.string()).describe('Derived printers deliberately withdrawn by this call'),
    unavailable: z
      .array(z.string())
      .describe(
        'Requested printers that are not in the derived set and therefore could not be enabled. Fixing these means re-slicing the model, not changing a setting.',
      ),
    requested_from: z
      .enum(['argument', 'settings'])
      .describe('Whether the target list came from supported_printers or from the printers plugin setting'),
    review: z.string().describe('What happens next'),
  }),
  handle: async (params, context) => {
    // Resolved before the profile is opened: fetching an editor route forks a
    // draft, so a request that was never going to be actionable should fail
    // without leaving one behind.
    const declared = declaredPrinters();
    const requestedFrom: 'argument' | 'settings' = params.supported_printers === undefined ? 'settings' : 'argument';
    const requested = params.supported_printers ?? declared.names;
    if (requested.length === 0) {
      throw ToolError.validation(
        'No printers were given and the "printers" plugin setting is empty, so there is nothing to narrow the profile to. Pass supported_printers, or record the printers you support once with: opentabs config set setting.makerworld.printers "X1 Carbon, P1S, A1"',
      );
    }
    if (requestedFrom === 'settings' && declared.unrecognised.length > 0) {
      throw ToolError.validation(
        `The "printers" plugin setting contains unrecognised entries: ${declared.unrecognised.join(', ')}. Fix the setting or pass supported_printers explicitly — narrowing compatibility from a misread list would withdraw printers unintentionally.`,
      );
    }

    context?.reportProgress({ progress: 0, total: 2, message: 'Opening the print profile…' });
    const page = await fetchPageData<RawProfileEditPage>(`/my/profiles/${params.instance_id}/edit`);

    const draft = page.detail;
    if (!draft?.id) {
      throw ToolError.notFound(
        `MakerWorld returned no editable draft for print profile ${params.instance_id}. Check the ID is correct and belongs to you.`,
      );
    }

    const fleet = (page.machines ?? []).filter(machine => printerName(machine).length > 0);
    if (fleet.length === 0) {
      throw ToolError.internal('MakerWorld did not return its printer list, so the request cannot be validated.');
    }

    // Device codes and casing are accepted, so "N1" and "a1 mini" both resolve
    // to the product name the fleet is keyed by.
    const known = new Set(fleet.map(printerName));
    const target = requested.map(entry => resolvePrinterName(entry) ?? entry.trim());
    const unknown = target.filter(name => !known.has(name));
    if (unknown.length > 0) {
      throw ToolError.validation(
        `Unrecognised printer name(s): ${unknown.join(', ')}. Valid names are: ${[...known].sort().join(', ')}.`,
      );
    }

    const primary = draft.compatibility?.devProductName ?? '';
    const derived = (draft.otherCompatibility ?? [])
      .map(printer => printer.devProductName ?? '')
      .filter(name => name.length > 0);

    const wanted = new Set(target);
    // The primary printer is fixed — the editor locks it and it cannot be withdrawn.
    const keep = new Set([primary, ...derived.filter(name => wanted.has(name))].filter(name => name.length > 0));

    // Every printer not being kept is opted out, matching what the web editor sends:
    // it lists all unticked machines, including ones outside the derived set.
    const unsupported = fleet.filter(machine => !keep.has(printerName(machine))).map(printerCode);

    const payload: Record<string, unknown> = {
      ...draft,
      ...EDITOR_FIELDS,
      tempDetails: (draft.details ?? []).map(url => ({ url, name: String(url).split('/').pop() ?? '' })),
      unsupportedDevModels: unsupported,
    };

    context?.reportProgress({ progress: 1, total: 2, message: 'Publishing the profile…' });
    await apiVoid('design-service', `/my/draft/${draft.id}`, { method: 'PUT', body: payload });
    await apiVoid('design-service', `/my/draft/${draft.id}/submit`, { method: 'POST', body: {} });

    return {
      instance_id: params.instance_id,
      primary_printer: primary,
      derived_printers: [...derived].sort(),
      will_publish: [...keep].sort(),
      withdrawn: derived.filter(name => !keep.has(name)).sort(),
      unavailable: target.filter(name => name !== primary && !derived.includes(name)).sort(),
      requested_from: requestedFrom,
      review:
        'Submitted for review. Edits driven through the API are routed to manual review rather than the automated path the website uses, so this can take longer than the couple of minutes a publish from the site takes. The profile keeps serving its current printer list until it clears.',
    };
  },
});
