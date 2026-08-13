/**
 * Printer identities, and the set the account owner wants to support.
 *
 * MakerWorld carries two identifiers for every printer and uses them in
 * different halves of the same document: a device code (`N1`) in the field a
 * draft is written with, and a product name (`A1 mini`) in the fields it is
 * read back from. The two appear together in exactly one place — the profile
 * editor's page props — and fetching that page forks a draft server-side, so no
 * read-only tool can look the pairing up. Hence this table.
 *
 * A name missing from it can only cause an under-report: tools union it with
 * whatever a profile already lists, and `set_printer_compatibility` validates
 * against the live fleet it has to read anyway.
 */

import { getConfig } from '@opentabs-dev/plugin-sdk';

export interface Printer {
  /** Device code, as written to `unsupportedDevModels`. */
  code: string;
  /** Product name, as read from `devProductName`. */
  name: string;
}

export const PRINTERS: readonly Printer[] = [
  { code: 'BL-P001', name: 'X1 Carbon' },
  { code: 'BL-P002', name: 'X1' },
  { code: 'C13', name: 'X1E' },
  { code: 'C11', name: 'P1P' },
  { code: 'C12', name: 'P1S' },
  { code: 'N7', name: 'P2S' },
  { code: 'N1', name: 'A1 mini' },
  { code: 'N2S', name: 'A1' },
  { code: 'N9', name: 'A2L' },
  { code: 'N6', name: 'X2D' },
  { code: 'O1C2', name: 'H2C' },
  { code: 'O1D', name: 'H2D' },
  { code: 'O1E', name: 'H2D Pro' },
  { code: 'O1S', name: 'H2S' },
];

/** Every product name this plugin knows, sorted for stable output. */
export const KNOWN_PRINTER_NAMES: readonly string[] = [...PRINTERS.map(printer => printer.name)].sort();

const byLowercaseKey = new Map<string, Printer>(
  PRINTERS.flatMap(printer => [
    [printer.name.toLowerCase(), printer] as const,
    [printer.code.toLowerCase(), printer] as const,
  ]),
);

/**
 * Resolve a product name or device code to its canonical product name.
 *
 * Accepts either identifier and ignores case, so a user writing `a1 mini` or
 * `N1` in their settings gets `A1 mini` either way.
 */
export const resolvePrinterName = (input: string): string | undefined =>
  byLowercaseKey.get(input.trim().toLowerCase())?.name;

/** The printers the account owner has in the room, as read from plugin settings. */
export interface OwnedPrinters {
  /** Canonical product names, deduplicated and sorted. Empty when unset. */
  names: string[];
  /** Setting entries matching no known printer, so a tool can report the typo. */
  unrecognised: string[];
}

/**
 * Read the `owned_printers` setting.
 *
 * This describes the hardware available for testing, and nothing else. It is
 * deliberately never used to decide which printers a model is published for:
 * a design is normally offered to every printer whose plate it fits, which has
 * no relationship to what its author happens to own.
 */
export const ownedPrinters = (): OwnedPrinters => {
  const raw = getConfig('owned_printers');
  if (typeof raw !== 'string' || raw.trim().length === 0) return { names: [], unrecognised: [] };

  const names = new Set<string>();
  const unrecognised: string[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const resolved = resolvePrinterName(trimmed);
    if (resolved) names.add(resolved);
    else unrecognised.push(trimmed);
  }

  return { names: [...names].sort(), unrecognised };
};
