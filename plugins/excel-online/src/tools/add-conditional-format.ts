import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { addressToEwaRange, bridgeOutputSchema, ewaBridge, viewportSelection } from '../bridge.js';

/**
 * Conditional-formatting rule kinds mapped to the `Command` code the EWA
 * `AddConditionalFormattingRule` method expects. The codes were decoded from
 * Excel Online's own client bundle (`EwaTS.conditionalformattingcommandhandlerservice.js`,
 * object `Ha.cMd` — menuItemId → Command), which matched every code observed in
 * live captures. `kind` selects how the rule's inputs map onto the wire fields:
 *
 * - `compare` — a single comparison value in `Formula1`
 * - `range`   — two bounds in `Formula1`/`Formula2` (the "between" rule)
 * - `text`    — the search text in `Formula1`
 * - `count`   — the number of items/percent in `Value`
 * - `flag`    — the duplicate/unique toggle in `Unique`
 * - `plain`   — no rule input (above/below average, no blanks)
 */
const RULES = {
  greater_than: { command: 1, kind: 'compare' },
  less_than: { command: 2, kind: 'compare' },
  equal_to: { command: 4, kind: 'compare' },
  between: { command: 3, kind: 'range' },
  greater_than_or_equal: { command: 68, kind: 'compare' },
  less_than_or_equal: { command: 69, kind: 'compare' },
  not_between: { command: 70, kind: 'range' },
  not_equal: { command: 71, kind: 'compare' },
  text_contains: { command: 5, kind: 'text' },
  duplicate_values: { command: 7, kind: 'flag' },
  no_blanks: { command: 65, kind: 'plain' },
  top_items: { command: 8, kind: 'count' },
  top_percent: { command: 9, kind: 'count' },
  bottom_items: { command: 10, kind: 'count' },
  bottom_percent: { command: 11, kind: 'count' },
  above_average: { command: 12, kind: 'plain' },
  below_average: { command: 13, kind: 'plain' },
} as const;

type HighlightRule = keyof typeof RULES;

/**
 * Visual rule styles, each its own `Command`. A data bar, color scale, or icon
 * set applies a built-in visual style rather than a cell fill — the chosen
 * style is the `Command`, so there is no `QuickFormatType` fill to pick.
 */
const DATA_BAR_STYLES = {
  gradient_blue: 15,
  gradient_green: 16,
  gradient_red: 17,
  gradient_orange: 18,
  gradient_light_blue: 19,
  gradient_purple: 20,
  solid_blue: 21,
  solid_green: 22,
  solid_red: 23,
  solid_orange: 24,
  solid_light_blue: 25,
  solid_purple: 26,
} as const;

const COLOR_SCALE_STYLES = {
  red_yellow_green: 27,
  green_yellow_red: 28,
  green_white_red: 29,
  red_white_green: 30,
  blue_white_red: 31,
  red_white_blue: 32,
  green_yellow: 33,
  yellow_green: 34,
  white_red: 35,
  red_white: 36,
  white_green: 37,
  green_white: 38,
} as const;

const ICON_SET_STYLES = {
  directional_3_arrows: 39,
  directional_3_arrows_gray: 40,
  indicators_3_flags: 41,
  shapes_3_traffic_lights_unrimmed: 42,
  shapes_3_traffic_lights_rimmed: 43,
  shapes_3_signs: 44,
  indicators_3_symbols_circled: 45,
  indicators_3_symbols_uncircled: 46,
  directional_4_arrows: 47,
  directional_4_arrows_gray: 48,
  shapes_4_red_to_black: 49,
  ratings_4: 50,
  shapes_4_traffic_lights: 51,
  directional_5_arrows: 52,
  directional_5_arrows_gray: 53,
  ratings_5: 54,
  ratings_5_quarters: 55,
  ratings_3_stars: 56,
  directional_3_triangles: 57,
  ratings_5_boxes: 58,
} as const;

const VISUAL = {
  data_bar: { styles: DATA_BAR_STYLES, defaultStyle: 'gradient_blue' },
  color_scale: { styles: COLOR_SCALE_STYLES, defaultStyle: 'green_yellow_red' },
  icon_set: { styles: ICON_SET_STYLES, defaultStyle: 'directional_3_arrows' },
} as const;

type VisualRule = keyof typeof VISUAL;

type RuleName = HighlightRule | VisualRule;

const isVisualRule = (rule: RuleName): rule is VisualRule => rule in VISUAL;

/**
 * Preset cell fills for highlight rules, mapped to `QuickFormatType` (Excel's
 * built-in dropdown order). `light_red_fill` and `green_fill` are
 * capture-confirmed; the rest follow the dialog's fixed order.
 */
const FORMATS = {
  light_red_fill: 0,
  yellow_fill: 1,
  green_fill: 2,
  light_red_fill_only: 3,
  red_text: 4,
  red_border: 5,
} as const;

type FormatName = keyof typeof FORMATS;

/**
 * `Value` the client sends by default for a rule with no numeric input (the
 * options class initialises it to 10). Visual styles carry this default;
 * comparison and top/bottom rules override it with 0 or the input count.
 */
const DEFAULT_VALUE = 10;

interface ConditionalFormatInput {
  worksheet: string;
  address: string;
  rule: RuleName;
  value?: string;
  value2?: string;
  count?: number;
  unique?: boolean;
  style?: string;
  format: FormatName;
}

/**
 * Build the `AddConditionalFormattingRule` options for a rule. Visual rules send
 * `Formula1/Formula2: null`, `CustomFormat: null`, and the style's `Command`;
 * highlight and top/bottom rules send a `QuickFormatType` fill plus their
 * comparison value(s), count, or duplicate/unique flag. `Priority: -1` appends
 * the rule after any existing ones.
 */
export const buildConditionalFormatOptions = (input: ConditionalFormatInput): Record<string, unknown> => {
  const range = addressToEwaRange(input.address);

  const conditionalFormattingOptions: Record<string, unknown> = {
    StopIfTrue: false,
    Priority: -1,
    Unique: false,
    TimePeriodType: 0,
  };

  if (isVisualRule(input.rule)) {
    const visual = VISUAL[input.rule];
    const styleName = input.style ?? visual.defaultStyle;
    conditionalFormattingOptions.Command = (visual.styles as Record<string, number>)[styleName];
    conditionalFormattingOptions.QuickFormatType = 0;
    conditionalFormattingOptions.Value = DEFAULT_VALUE;
    conditionalFormattingOptions.Formula1 = null;
    conditionalFormattingOptions.Formula2 = null;
    conditionalFormattingOptions.CustomFormat = null;
  } else {
    const def = RULES[input.rule];
    conditionalFormattingOptions.Command = def.command;
    conditionalFormattingOptions.QuickFormatType = FORMATS[input.format];
    conditionalFormattingOptions.Value = def.kind === 'count' ? (input.count ?? 0) : 0;

    if (def.kind === 'compare' || def.kind === 'text') {
      conditionalFormattingOptions.Formula1 = input.value;
    } else if (def.kind === 'range') {
      conditionalFormattingOptions.Formula1 = input.value;
      conditionalFormattingOptions.Formula2 = input.value2;
    } else if (def.kind === 'flag') {
      conditionalFormattingOptions.Unique = input.unique ?? false;
    }
  }

  return {
    conditionalFormattingOptions,
    selectedRanges: { SheetName: input.worksheet, NamedObjectName: null, Ranges: [range] },
    activeCell: { FirstRow: range.FirstRow, FirstColumn: range.FirstColumn },
  };
};

/** Style names accepted for each visual rule, for validation and error messages. */
const stylesForVisual = (rule: VisualRule): string[] => Object.keys(VISUAL[rule].styles);

const RULE_NAMES = [...Object.keys(RULES), ...Object.keys(VISUAL)] as [RuleName, ...RuleName[]];

export const addConditionalFormat = defineTool({
  name: 'add_conditional_format',
  displayName: 'Add Conditional Format',
  description:
    'Add a conditional-formatting rule to a range. Highlight comparisons (greater_than, less_than, ' +
    'equal_to, greater_than_or_equal, less_than_or_equal, not_equal, between, not_between, text_contains) ' +
    'and top/bottom rules (top_items, top_percent, bottom_items, bottom_percent, above_average, ' +
    'below_average) take a preset "format" fill; duplicate_values and no_blanks highlight matching cells; ' +
    'and the visual styles data_bar, color_scale, and icon_set take a "style" selecting the exact built-in ' +
    'variant. Provide "value" for single-value comparisons and text_contains, "value" and "value2" for ' +
    'between/not_between, "count" for top/bottom, and "unique" for duplicate_values. Not available through ' +
    "the standard workbook API — driven through Excel's internal service via the frame bridge.",
  summary: 'Add a conditional-formatting rule',
  icon: 'palette',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation to format (e.g., "E4:E8")'),
    rule: z
      .enum(RULE_NAMES)
      .describe('Rule kind: a highlight comparison, top/bottom, duplicate/blank, or a visual style'),
    value: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Comparison value (greater_than/less_than/equal_to/greater_than_or_equal/less_than_or_equal/not_equal, ' +
          'lower bound for between/not_between); or the search text for text_contains',
      ),
    value2: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Upper value — required for the "between" and "not_between" rules'),
    count: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of items or percent — required for top_items/top_percent/bottom_items/bottom_percent'),
    unique: z
      .boolean()
      .optional()
      .describe('For duplicate_values: false (default) highlights duplicates, true highlights unique values'),
    style: z
      .string()
      .optional()
      .describe(
        'Built-in variant for a visual rule. data_bar: gradient_blue|…|solid_purple (default gradient_blue). ' +
          'color_scale: green_yellow_red|red_yellow_green|blue_white_red|… (default green_yellow_red). ' +
          'icon_set: directional_3_arrows|shapes_3_traffic_lights_rimmed|ratings_5_stars|… (default directional_3_arrows).',
      ),
    format: z
      .enum(Object.keys(FORMATS) as [FormatName, ...FormatName[]])
      .optional()
      .describe('Preset fill for highlight/top-bottom rules (default light_red_fill). Ignored by visual rules.'),
  }),
  output: bridgeOutputSchema,
  handle: async params => {
    const value = params.value === undefined ? undefined : String(params.value);
    const value2 = params.value2 === undefined ? undefined : String(params.value2);

    if (isVisualRule(params.rule)) {
      const valid = stylesForVisual(params.rule);
      if (params.style !== undefined && !valid.includes(params.style)) {
        throw ToolError.validation(
          `Unknown ${params.rule} style "${params.style}". Valid styles: ${valid.join(', ')}.`,
        );
      }
    } else {
      const def = RULES[params.rule];
      if ((def.kind === 'compare' || def.kind === 'text') && value === undefined) {
        throw ToolError.validation(`Rule "${params.rule}" requires "value".`);
      }
      if (def.kind === 'range' && (value === undefined || value2 === undefined)) {
        throw ToolError.validation(`The "${params.rule}" rule requires both "value" (lower) and "value2" (upper).`);
      }
      if (def.kind === 'count' && params.count === undefined) {
        throw ToolError.validation(`Rule "${params.rule}" requires "count".`);
      }
    }

    return ewaBridge(
      'AddConditionalFormattingRule',
      buildConditionalFormatOptions({
        worksheet: params.worksheet,
        address: params.address,
        rule: params.rule,
        value,
        value2,
        count: params.count,
        unique: params.unique,
        style: params.style,
        format: params.format ?? 'light_red_fill',
      }),
      {
        // Conditional formatting is a stateful, selection-scoped dialog method,
        // like data validation — but it accepts the out-of-band commit.
        prep: { method: 'GetConditionalFormattingRules', options: {} },
        contextPatch: viewportSelection(params.worksheet, params.address),
      },
    );
  },
});
