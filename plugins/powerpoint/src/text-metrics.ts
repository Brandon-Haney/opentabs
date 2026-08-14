/**
 * Text fitting estimates for slide text boxes.
 *
 * Writing text into a fixed box can overflow the slide, and nothing else in the
 * plugin can answer "will this fit?". Exact measurement needs the rendered font,
 * which means shipping a rasteriser and the font files themselves — neither is
 * justified here. Instead this models a line of text as `characters x average
 * advance width`, which for Latin text at presentation sizes lands close enough
 * to pick a font size that fits.
 *
 * The estimate is deliberately slightly pessimistic: over-estimating height
 * makes text a little smaller than strictly necessary, while under-estimating
 * puts it off the edge of the slide. Only one of those is recoverable by eye.
 */

/**
 * Average glyph advance as a fraction of the font size, for mixed-case Latin
 * prose. Condensed and wide faces differ enough to be worth naming; anything
 * unlisted falls back to the default, which suits the humanist sans faces
 * PowerPoint ships as theme fonts.
 */
const AVERAGE_ADVANCE_RATIO: Record<string, number> = {
  aptos: 0.5,
  'aptos display': 0.5,
  calibri: 0.48,
  arial: 0.52,
  helvetica: 0.52,
  verdana: 0.58,
  tahoma: 0.51,
  'times new roman': 0.46,
  georgia: 0.5,
  'courier new': 0.6,
  consolas: 0.55,
};

const DEFAULT_ADVANCE_RATIO = 0.5;

/** Line box as a multiple of font size, matching PowerPoint's single spacing. */
const DEFAULT_LINE_SPACING = 1.2;

/** Default `<a:bodyPr>` insets in inches: 0.1in left/right, 0.05in top/bottom. */
const DEFAULT_INSET_X_IN = 0.1;
const DEFAULT_INSET_Y_IN = 0.05;

const POINTS_PER_INCH = 72;

export interface TextFitOptions {
  /** Font family name; unlisted families use a humanist-sans default. */
  font?: string;
  /** Line box as a multiple of font size. Defaults to 1.2 (single spacing). */
  lineSpacing?: number;
  /**
   * Indent applied to wrapped body text, in inches. Bulleted paragraphs hang
   * their text past the bullet, so the usable width is narrower than the box.
   */
  indentIn?: number;
  /** Horizontal inset per side, in inches. */
  insetXIn?: number;
  /** Vertical inset per side, in inches. */
  insetYIn?: number;
  /** Extra space between paragraphs, as a multiple of font size. */
  paragraphSpacing?: number;
}

const advanceRatioFor = (font: string | undefined): number =>
  (font ? AVERAGE_ADVANCE_RATIO[font.trim().toLowerCase()] : undefined) ?? DEFAULT_ADVANCE_RATIO;

/**
 * Estimate the height a block of text needs, in inches.
 *
 * Each `\n`-separated line is one paragraph, wrapped independently — an empty
 * paragraph still occupies a line, which is how blank lines behave on a slide.
 */
const estimateTextHeight = (
  text: string,
  fontSizePt: number,
  boxWidthIn: number,
  options: TextFitOptions = {},
): number => {
  const {
    font,
    lineSpacing = DEFAULT_LINE_SPACING,
    indentIn = 0,
    insetXIn = DEFAULT_INSET_X_IN,
    insetYIn = DEFAULT_INSET_Y_IN,
    paragraphSpacing = 0,
  } = options;

  const usableWidthIn = boxWidthIn - insetXIn * 2 - indentIn;
  if (usableWidthIn <= 0) return Number.POSITIVE_INFINITY;

  const charWidthIn = (fontSizePt * advanceRatioFor(font)) / POINTS_PER_INCH;
  const charsPerLine = Math.max(1, Math.floor(usableWidthIn / charWidthIn));

  const paragraphs = text.split('\n');
  let lines = 0;
  for (const paragraph of paragraphs) {
    lines += Math.max(1, Math.ceil(paragraph.length / charsPerLine));
  }

  const lineHeightIn = (fontSizePt * lineSpacing) / POINTS_PER_INCH;
  const paragraphGapIn = (fontSizePt * paragraphSpacing) / POINTS_PER_INCH;
  return lines * lineHeightIn + Math.max(0, paragraphs.length - 1) * paragraphGapIn + insetYIn * 2;
};

export interface TextFitResult {
  /** Largest whole-point size at or below `maxFontSizePt` that fits. */
  fontSizePt: number;
  /** Estimated height at that size, in inches. */
  estimatedHeightIn: number;
  /** False when even `minFontSizePt` overflows — the caller must shorten or resize. */
  fits: boolean;
}

/**
 * Choose the largest whole-point font size at which `text` fits the box.
 *
 * Steps down from `maxFontSizePt` rather than solving directly: line counts are
 * a step function of size, so the closed form would still need checking, and
 * presentation sizes span a small enough range that stepping is immediate.
 * Returns `fits: false` with the floor size when nothing fits, so a caller can
 * choose between shortening the text and enlarging the box.
 */
export const fitFontSize = (
  text: string,
  boxWidthIn: number,
  boxHeightIn: number,
  maxFontSizePt: number,
  minFontSizePt = 8,
  options: TextFitOptions = {},
): TextFitResult => {
  // The floor never rises above the ceiling. A caller asking for a minimum
  // larger than the maximum has asked for something impossible, and returning
  // the minimum there would hand back a size *above* the stated ceiling — the
  // one outcome the ceiling exists to prevent.
  const ceiling = Math.floor(maxFontSizePt);
  const floor = Math.min(Math.floor(minFontSizePt), ceiling);

  for (let size = ceiling; size >= floor; size--) {
    const estimatedHeightIn = estimateTextHeight(text, size, boxWidthIn, options);
    if (estimatedHeightIn <= boxHeightIn) return { fontSizePt: size, estimatedHeightIn, fits: true };
  }
  return {
    fontSizePt: floor,
    estimatedHeightIn: estimateTextHeight(text, floor, boxWidthIn, options),
    fits: false,
  };
};
