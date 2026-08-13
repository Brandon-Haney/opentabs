import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiVoid, fetchPageData } from '../makerworld-api.js';
import { resolvePrinterName } from '../printers.js';
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
    'Change which printers a print profile is offered for, either by withdrawing named printers or by giving the complete set to keep. This can only ever narrow the list, never widen it: MakerWorld derives the printers a profile can slice for from the 3MF itself, and that derived set is a hard ceiling — naming a printer outside it changes nothing, and the tool says so rather than pretending. Restoring a printer missing from the derived set requires re-slicing and replacing the file, which no tool can do. Prefer withdraw_printers: a design is normally offered to every printer whose plate it fits, so the usual edit is dropping the one or two it does not fit, and passing the full keep-list instead risks silently withdrawing everything left out of it. Call get_print_profiles first for the instance ID and the current list.',
  summary: 'Withdraw printers from a print profile',
  icon: 'printer',
  group: 'Models',
  input: z.object({
    instance_id: z.number().int().describe('Print profile ID, from get_print_profiles'),
    withdraw_printers: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Printers to stop offering the profile for, by product name such as "A1 mini" or by device code. Everything else MakerWorld derived stays. This is the safe way to make a small change, since printers not named are untouched. Give this or supported_printers, not both.',
      ),
    supported_printers: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        "The complete set of printers to keep offering the profile for. Anything derived and absent from this list is withdrawn, so an incomplete list quietly narrows the model — pass it only when replacing the whole list deliberately. The profile's primary printer is always kept and does not need listing. Give this or withdraw_printers, not both.",
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        'Report exactly what the change would do without submitting it (default false). Worth doing first for supported_printers, where the withdrawn list is the part easy to get wrong.',
      ),
  }),
  output: z.object({
    instance_id: z.number().describe('Print profile that was changed'),
    primary_printer: z.string().describe("The profile's primary printer, which is always kept"),
    derived_printers: z
      .array(z.string())
      .describe('Everything MakerWorld derived from the 3MF — the ceiling on what can be offered'),
    will_publish: z.array(z.string()).describe('Printers the profile will be offered for once review clears'),
    withdrawn: z.array(z.string()).describe('Derived printers this call takes away'),
    ignored: z
      .array(z.string())
      .describe(
        'Printers named in the request that MakerWorld never derived for this profile, so naming them changed nothing. In supported_printers they cannot be enabled without re-slicing; in withdraw_printers they were not being offered anyway.',
      ),
    review: z.string().describe('What happens next'),
  }),
  handle: async (params, context) => {
    // Checked before the profile is opened: fetching an editor route forks a
    // draft, so a request that was never going to be actionable should fail
    // without leaving one behind.
    const named = params.withdraw_printers ?? params.supported_printers;
    if (named === undefined || (params.withdraw_printers !== undefined && params.supported_printers !== undefined)) {
      throw ToolError.validation(
        'Give exactly one of withdraw_printers or supported_printers. withdraw_printers drops the printers you name and leaves the rest alone; supported_printers replaces the whole list, withdrawing everything you leave out.',
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
    const target = named.map(entry => resolvePrinterName(entry) ?? entry.trim());
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

    if (params.withdraw_printers !== undefined && target.includes(primary)) {
      throw ToolError.validation(
        `${primary} is this profile's primary printer and the editor locks it, so it cannot be withdrawn. Delete the profile instead if it should not be offered at all.`,
      );
    }

    // Both inputs reduce to the same thing — the derived printers to keep —
    // so the payload and the report below are written once.
    const survives = (name: string): boolean =>
      params.withdraw_printers !== undefined ? !target.includes(name) : target.includes(name);

    // The primary printer is fixed — the editor locks it and it cannot be withdrawn.
    const keep = new Set([primary, ...derived.filter(survives)].filter(name => name.length > 0));

    // Every printer not being kept is opted out, matching what the web editor sends:
    // it lists all unticked machines, including ones outside the derived set.
    const unsupported = fleet.filter(machine => !keep.has(printerName(machine))).map(printerCode);

    if (params.dry_run !== true) {
      const payload: Record<string, unknown> = {
        ...draft,
        ...EDITOR_FIELDS,
        tempDetails: (draft.details ?? []).map(url => ({ url, name: String(url).split('/').pop() ?? '' })),
        unsupportedDevModels: unsupported,
      };

      context?.reportProgress({ progress: 1, total: 2, message: 'Publishing the profile…' });
      await apiVoid('design-service', `/my/draft/${draft.id}`, { method: 'PUT', body: payload });
      await apiVoid('design-service', `/my/draft/${draft.id}/submit`, { method: 'POST', body: {} });
    }

    return {
      instance_id: params.instance_id,
      primary_printer: primary,
      derived_printers: [...derived].sort(),
      will_publish: [...keep].sort(),
      withdrawn: derived.filter(name => !keep.has(name)).sort(),
      ignored: target.filter(name => name !== primary && !derived.includes(name)).sort(),
      review:
        params.dry_run === true
          ? 'Dry run — nothing was submitted and the profile is unchanged. Re-run without dry_run to apply exactly the will_publish and withdrawn lists above.'
          : 'Submitted for review. Edits driven through the API are routed to manual review rather than the automated path the website uses, so this can take longer than the couple of minutes a publish from the site takes. The profile keeps serving its current printer list until it clears.',
    };
  },
});
