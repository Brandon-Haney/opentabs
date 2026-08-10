/**
 * Recognise a measure that computes its own period.
 *
 * A cube measure built on DAX time intelligence — "CMTD Sales", "LYTD Sales",
 * "PM Payroll % of Sales" — derives its own date range and ignores whatever date
 * sits in the PivotTable's rows or page filters. Put twenty months in rows
 * against one of these and every row returns the same number, which reads as
 * real data rather than as a mistake: the figures are correctly formatted, of a
 * plausible magnitude, and identical only if someone looks.
 *
 * The pivot cache publishes no formula, so this is inferred from the caption
 * alone. That is why what is exported is a hint the caller is told to confirm
 * against `display_folder` rather than a fact: a model is free to name a measure
 * however it likes, and the inference can be wrong in both directions.
 */

/**
 * Prefixes that mark a period the measure supplies for itself.
 *
 * Current/last/prior month-, week- and year-to-date and their variances, plus
 * the bare period abbreviations. Ordered longest-first so that "CMTD" is not
 * matched as "CM", and anchored to the start of the caption because these are
 * conventionally written as a prefix.
 */
const PERIOD_PREFIXES = [
  'CMTD',
  'CYTD',
  'LMTD',
  'LYTD',
  'CWTD',
  'PWTD',
  'PYPM',
  'MTD',
  'YTD',
  'PM',
  'LM',
  'CM',
  'CY',
  'LY',
  'Yesterday',
  'Prior Month',
] as const;

/**
 * Matches a prefix followed by a separator rather than more word characters, so
 * "CM Sales" is a hit and a measure that merely begins with those letters —
 * "Cost of Materials" — is not.
 */
const PERIOD_PREFIX_PATTERN = new RegExp(`^(?:${PERIOD_PREFIXES.join('|')})(?![A-Za-z0-9])`, 'i');

/** True when `caption` names a measure that supplies its own period. */
export const isPeriodRelative = (caption: string): boolean => PERIOD_PREFIX_PATTERN.test(caption.trim());
