/**
 * Colour values, written the way the deck defines them.
 *
 * A hex literal is a fixed colour forever. A theme slot — `accent1`, `bg1` — is
 * a reference the deck resolves, so a shape written with one follows the
 * template: it picks up the corporate palette, changes when the theme changes,
 * and matches the layouts a person picks from the New Slide gallery. Authoring
 * everything in raw hex produces slides that are subtly, permanently off-theme.
 *
 * Both forms are accepted wherever a colour is taken, and `get_slide_layout`
 * reports theme colours as `scheme:accent1`, so a value read from a slide can be
 * written straight back.
 */

import { ToolError } from '@opentabs-dev/plugin-sdk';
import { A_NS } from './xml.js';

/**
 * `ST_SchemeColorVal`. `dk1`/`lt1`/`dk2`/`lt2` name the theme's own entries,
 * while `bg1`/`tx1`/`bg2`/`tx2` name them as the slide's colour map assigns
 * them — the latter is what PowerPoint's own UI writes, and what follows a
 * layout that inverts light and dark.
 */
const SCHEME_COLORS = new Set([
  'bg1',
  'tx1',
  'bg2',
  'tx2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'phClr',
]);

/** Luminance modifiers, in thousandths of a percent, matching PowerPoint's own steps. */
const LUM_MOD_UNITS = 1000;

/** A colour resolved to what it will become in the XML. */
type ParsedColor = { kind: 'srgb'; value: string } | { kind: 'scheme'; value: string; lighten?: number };

/**
 * Parse a caller-supplied colour.
 *
 * Accepts `"FFCC00"`, `"#ffcc00"`, `"accent1"`, `"scheme:accent1"`, and a theme
 * slot with a lightness step — `"accent1 lighter 40%"` — which is how a deck
 * gets the tinted card backgrounds a designer would use rather than a hand-mixed
 * hex that stops matching the moment the theme moves.
 */
const parseColor = (input: string, label: string): ParsedColor => {
  const trimmed = input.trim();

  const lightened = /^(?:scheme:)?([A-Za-z0-9]+)\s+lighter\s+(\d{1,3})%$/i.exec(trimmed);
  if (lightened) {
    const [, slot = '', percent = '0'] = lightened;
    const name = canonicalSchemeName(slot);
    if (!name) throw invalidColor(input, label);
    const amount = Number.parseInt(percent, 10);
    if (amount < 1 || amount > 99) {
      throw ToolError.validation(`Invalid ${label} color: ${input} — "lighter" takes 1–99%.`);
    }
    return { kind: 'scheme', value: name, lighten: amount };
  }

  const schemeName = canonicalSchemeName(trimmed.replace(/^scheme:/i, ''));
  if (schemeName) return { kind: 'scheme', value: schemeName };

  const hex = trimmed.replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return { kind: 'srgb', value: hex };

  throw invalidColor(input, label);
};

/** Match a scheme slot case-insensitively, returning the schema's own spelling. */
const canonicalSchemeName = (name: string): string | undefined => {
  const lower = name.toLowerCase();
  for (const known of SCHEME_COLORS) {
    if (known.toLowerCase() === lower) return known;
  }
  return undefined;
};

const invalidColor = (input: string, label: string): ToolError =>
  ToolError.validation(
    `Invalid ${label} color: "${input}". Use a 6-digit hex like "FFCC00", a theme color like "accent1" ` +
      `(preferred — it follows the deck's template), or a tint like "accent1 lighter 40%".`,
  );

/**
 * Build the colour child that goes inside `<a:solidFill>` (or any other colour
 * container). Validates before creating anything, so an invalid value never
 * reaches the package.
 */
export const buildColorElement = (doc: Document, input: string, label: string): Element => {
  const parsed = parseColor(input, label);

  if (parsed.kind === 'srgb') {
    const srgb = doc.createElementNS(A_NS, 'a:srgbClr');
    srgb.setAttribute('val', parsed.value);
    return srgb;
  }

  const scheme = doc.createElementNS(A_NS, 'a:schemeClr');
  scheme.setAttribute('val', parsed.value);
  if (parsed.lighten !== undefined) {
    // PowerPoint expresses "lighter N%" as a pair: keep (100−N) of the base
    // luminance and add N of white. Order matters — lumMod precedes lumOff.
    const lumMod = doc.createElementNS(A_NS, 'a:lumMod');
    lumMod.setAttribute('val', String((100 - parsed.lighten) * LUM_MOD_UNITS));
    scheme.appendChild(lumMod);
    const lumOff = doc.createElementNS(A_NS, 'a:lumOff');
    lumOff.setAttribute('val', String(parsed.lighten * LUM_MOD_UNITS));
    scheme.appendChild(lumOff);
  }
  return scheme;
};

/** Build a complete `<a:solidFill>` wrapping the colour. */
export const buildSolidFill = (doc: Document, input: string, label: string): Element => {
  const solidFill = doc.createElementNS(A_NS, 'a:solidFill');
  solidFill.appendChild(buildColorElement(doc, input, label));
  return solidFill;
};

/** Shared wording for the colour inputs on every tool that takes one. */
export const COLOR_INPUT_DESCRIPTION =
  'Hex like "FFCC00", or — preferred — a theme color like "accent1", "bg1", "tx1", so it follows the deck\'s ' +
  'template and survives a theme change. Tints are supported as "accent1 lighter 40%".';
