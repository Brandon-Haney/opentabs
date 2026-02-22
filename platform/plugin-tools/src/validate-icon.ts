/**
 * SVG icon validation and auto-grayscale generation for plugin icons.
 *
 * Three exports:
 * - validateIconSvg — structural validation (size, viewBox, forbidden elements)
 * - validateInactiveIconColors — ensures only achromatic colors are present
 * - generateInactiveIcon — converts all color values to luminance-equivalent grays
 */

const MAX_ICON_SIZE = 8 * 1024; // 8 KB

// ---------------------------------------------------------------------------
// Named color lookup table (CSS2.1 + common extended names)
// ---------------------------------------------------------------------------

const NAMED_COLORS: Record<string, [number, number, number]> = {
  aqua: [0, 255, 255],
  black: [0, 0, 0],
  blue: [0, 0, 255],
  fuchsia: [255, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  maroon: [128, 0, 0],
  navy: [0, 0, 128],
  olive: [128, 128, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  silver: [192, 192, 192],
  teal: [0, 128, 128],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
  gold: [255, 215, 0],
  indigo: [75, 0, 130],
  coral: [255, 127, 80],
  crimson: [220, 20, 60],
  tomato: [255, 99, 71],
  salmon: [250, 128, 114],
  orchid: [218, 112, 214],
  plum: [221, 160, 221],
  chocolate: [210, 105, 30],
  tan: [210, 180, 140],
  peru: [205, 133, 63],
  sienna: [160, 82, 45],
  firebrick: [178, 34, 34],
  darkred: [139, 0, 0],
  darkgreen: [0, 100, 0],
  darkblue: [0, 0, 139],
  darkcyan: [0, 139, 139],
  darkmagenta: [139, 0, 139],
  darkviolet: [148, 0, 211],
  deeppink: [255, 20, 147],
  deepskyblue: [0, 191, 255],
  dodgerblue: [30, 144, 255],
  hotpink: [255, 105, 180],
  lawngreen: [124, 252, 0],
  limegreen: [50, 205, 50],
  mediumblue: [0, 0, 205],
  mediumorchid: [186, 85, 211],
  mediumpurple: [147, 111, 219],
  mediumseagreen: [60, 179, 113],
  mediumslateblue: [123, 104, 238],
  mediumspringgreen: [0, 250, 154],
  mediumturquoise: [72, 209, 204],
  mediumvioletred: [199, 21, 133],
  midnightblue: [25, 25, 112],
  orangered: [255, 69, 0],
  palegreen: [152, 251, 152],
  palevioletred: [219, 112, 147],
  royalblue: [65, 105, 225],
  saddlebrown: [139, 69, 19],
  seagreen: [46, 139, 87],
  skyblue: [135, 206, 235],
  slateblue: [106, 90, 205],
  springgreen: [0, 255, 127],
  steelblue: [70, 130, 180],
  turquoise: [64, 224, 208],
  violet: [238, 130, 238],
  wheat: [245, 222, 179],
  yellowgreen: [154, 205, 50],
  // Achromatic named colors
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  gainsboro: [220, 220, 220],
  whitesmoke: [245, 245, 245],
};

// ---------------------------------------------------------------------------
// Achromatic color names (allowed in inactive icons)
// ---------------------------------------------------------------------------

const ACHROMATIC_NAMES = new Set([
  'black',
  'white',
  'gray',
  'grey',
  'silver',
  'dimgray',
  'dimgrey',
  'darkgray',
  'darkgrey',
  'lightgray',
  'lightgrey',
  'gainsboro',
  'whitesmoke',
]);

// Values that are not actual colors and should be passed through unchanged
const PASSTHROUGH_VALUES = new Set(['none', 'currentcolor', 'transparent', 'inherit', 'unset', 'initial']);

// Color-carrying attributes in SVG
const COLOR_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color'];

// Event handler attributes to reject
const EVENT_HANDLER_RE =
  /\bon(?:abort|activate|afterprint|beforeprint|beforeunload|blur|cancel|canplay|canplaythrough|change|click|close|contextmenu|copy|cuechange|cut|dblclick|drag|dragend|dragenter|dragleave|dragover|dragstart|drop|durationchange|emptied|ended|error|focus|focusin|focusout|formdata|fullscreenchange|fullscreenerror|hashchange|input|invalid|keydown|keypress|keyup|load|loadeddata|loadedmetadata|loadstart|message|messageerror|mousedown|mouseenter|mouseleave|mousemove|mouseout|mouseover|mouseup|offline|online|open|pagehide|pageshow|paste|pause|play|playing|pointercancel|pointerdown|pointerenter|pointerleave|pointermove|pointerout|pointerover|pointerup|popstate|progress|ratechange|reset|resize|scroll|securitypolicyviolation|seeked|seeking|select|slotchange|stalled|storage|submit|suspend|timeupdate|toggle|touchcancel|touchend|touchmove|touchstart|transitioncancel|transitionend|transitionrun|transitionstart|unhandledrejection|unload|volumechange|waiting|wheel)\s*=/i;

// ---------------------------------------------------------------------------
// Color parsing utilities
// ---------------------------------------------------------------------------

/** Parse a hex color (#RGB or #RRGGBB) to [R, G, B] */
const parseHex = (hex: string): [number, number, number] | null => {
  const h = hex.trim();
  if (h.length === 4) {
    const c1 = h[1] ?? '0';
    const c2 = h[2] ?? '0';
    const c3 = h[3] ?? '0';
    const r = parseInt(c1 + c1, 16);
    const g = parseInt(c2 + c2, 16);
    const b = parseInt(c3 + c3, 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  if (h.length === 7) {
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  return null;
};

/** Convert HSL to RGB. h is 0-360, s/l are 0-100 percentages. */
const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r1: number, g1: number, b1: number;
  if (h < 60) {
    [r1, g1, b1] = [c, x, 0];
  } else if (h < 120) {
    [r1, g1, b1] = [x, c, 0];
  } else if (h < 180) {
    [r1, g1, b1] = [0, c, x];
  } else if (h < 240) {
    [r1, g1, b1] = [0, x, c];
  } else if (h < 300) {
    [r1, g1, b1] = [x, 0, c];
  } else {
    [r1, g1, b1] = [c, 0, x];
  }
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
};

/** Compute luminance-equivalent gray value using ITU-R BT.709 */
const toLuminanceGray = (r: number, g: number, b: number): number => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);

/** Convert a gray value (0-255) to a two-digit hex string */
const grayToHex = (gray: number): string => {
  const h = Math.max(0, Math.min(255, gray)).toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};

/**
 * Parse a CSS color value into [R, G, B] or null if not a recognizable color.
 * Returns null for passthrough values (none, currentColor, etc.) and url() references.
 */
const parseColor = (value: string): [number, number, number] | null => {
  const v = value.trim();
  const vLower = v.toLowerCase();

  // Passthrough values
  if (PASSTHROUGH_VALUES.has(vLower)) return null;

  // URL references (e.g., url(#gradient))
  if (vLower.startsWith('url(')) return null;

  // Hex colors
  if (v.startsWith('#')) return parseHex(v);

  // rgb()/rgba()
  const rgbMatch = vLower.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return [parseInt(rgbMatch[1] ?? '0', 10), parseInt(rgbMatch[2] ?? '0', 10), parseInt(rgbMatch[3] ?? '0', 10)];
  }

  // hsl()/hsla()
  const hslMatch = vLower.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/);
  if (hslMatch) {
    return hslToRgb(parseFloat(hslMatch[1] ?? '0'), parseFloat(hslMatch[2] ?? '0'), parseFloat(hslMatch[3] ?? '0'));
  }

  // Named colors
  const named = NAMED_COLORS[vLower];
  if (named) return named;

  return null;
};

/** Check if a parsed RGB is achromatic (R === G === B) */
const isAchromatic = (r: number, g: number, b: number): boolean => r === g && g === b;

/** Check if a CSS color string is achromatic (or a passthrough value) */
const isAchromaticColor = (value: string): boolean => {
  const v = value.trim().toLowerCase();

  if (PASSTHROUGH_VALUES.has(v)) return true;
  if (v.startsWith('url(')) return true;
  if (ACHROMATIC_NAMES.has(v)) return true;

  // hsl/hsla — check saturation is 0
  const hslMatch = v.match(/^hsla?\(\s*[\d.]+\s*,\s*([\d.]+)%/);
  if (hslMatch) return parseFloat(hslMatch[1] ?? '0') === 0;

  const rgb = parseColor(v);
  if (!rgb) return true; // Unrecognized values are considered achromatic
  return isAchromatic(rgb[0], rgb[1], rgb[2]);
};

// ---------------------------------------------------------------------------
// validateIconSvg
// ---------------------------------------------------------------------------

type ValidationResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Validate an SVG string for use as a plugin icon.
 * Checks: size <= 8KB, viewBox present and square, no <image>/<script>,
 * no event handler attributes.
 */
const validateIconSvg = (content: string, _filename: string): ValidationResult => {
  const errors: string[] = [];

  // Size check (byte count, not string length)
  const byteSize = new TextEncoder().encode(content).byteLength;
  if (byteSize > MAX_ICON_SIZE) {
    errors.push(`SVG size (${byteSize} bytes) exceeds maximum of ${MAX_ICON_SIZE} bytes (8 KB)`);
  }

  // viewBox check
  const viewBoxMatch = content.match(/viewBox\s*=\s*["']([^"']*)["']/);
  if (!viewBoxMatch) {
    errors.push('SVG must have a viewBox attribute');
  } else {
    const viewBoxValue = viewBoxMatch[1] ?? '';
    const parts = viewBoxValue.trim().split(/\s+/);
    if (parts.length === 4) {
      const w = parseFloat(parts[2] ?? '0');
      const h = parseFloat(parts[3] ?? '0');
      if (w !== h) {
        errors.push(`SVG viewBox must be square (got ${w}x${h})`);
      }
    } else {
      errors.push('SVG viewBox must have exactly 4 values (min-x min-y width height)');
    }
  }

  // Forbidden elements: <image>
  if (/<image[\s/>]/i.test(content)) {
    errors.push('SVG must not contain <image> elements');
  }

  // Forbidden elements: <script>
  if (/<script[\s/>]/i.test(content)) {
    errors.push('SVG must not contain <script> elements');
  }

  // Event handler attributes
  if (EVENT_HANDLER_RE.test(content)) {
    errors.push('SVG must not contain event handler attributes (e.g., onclick, onload, onerror)');
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
};

// ---------------------------------------------------------------------------
// validateInactiveIconColors
// ---------------------------------------------------------------------------

/**
 * Validate that an SVG contains only achromatic colors.
 * Checks fill, stroke, stop-color, and flood-color attributes and inline styles.
 */
const validateInactiveIconColors = (content: string): ValidationResult => {
  const errors: string[] = [];

  // Check attribute values: (fill|stroke|stop-color|flood-color)="value"
  const attrPattern = new RegExp(`(${COLOR_ATTRS.join('|')})\\s*=\\s*"([^"]*)"`, 'gi');
  let attrMatch;
  while ((attrMatch = attrPattern.exec(content)) !== null) {
    const attr = attrMatch[1] ?? '';
    const value = (attrMatch[2] ?? '').trim();
    if (value && !isAchromaticColor(value)) {
      errors.push(`Attribute ${attr}="${value}" uses a saturated color`);
    }
  }

  // Check inline style property values: style="fill: value; stroke: value"
  const stylePattern = /style\s*=\s*"([^"]*)"/gi;
  let styleMatch;
  while ((styleMatch = stylePattern.exec(content)) !== null) {
    const styleValue = styleMatch[1] ?? '';
    for (const attr of COLOR_ATTRS) {
      const propPattern = new RegExp(`${attr.replace('-', '\\-')}\\s*:\\s*([^;"]+)`, 'gi');
      let propMatch;
      while ((propMatch = propPattern.exec(styleValue)) !== null) {
        const value = (propMatch[1] ?? '').trim();
        if (value && !isAchromaticColor(value)) {
          errors.push(`Style property ${attr}: ${value} uses a saturated color`);
        }
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
};

// ---------------------------------------------------------------------------
// generateInactiveIcon
// ---------------------------------------------------------------------------

/**
 * Convert a single color value to its grayscale equivalent.
 * Returns the original value for passthrough values (none, currentColor, etc.)
 */
const convertColorToGray = (value: string): string => {
  const v = value.trim();
  const vLower = v.toLowerCase();

  if (PASSTHROUGH_VALUES.has(vLower)) return v;
  if (vLower.startsWith('url(')) return v;

  // hsl/hsla — set saturation to 0, preserve everything else
  const hslaMatch = vLower.match(/^(hsla?)\(\s*([\d.]+)\s*,\s*[\d.]+%\s*,\s*([\d.]+%)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (hslaMatch) {
    const fn = hslaMatch[1] ?? 'hsl';
    const hue = hslaMatch[2] ?? '0';
    const lightness = hslaMatch[3] ?? '50%';
    const alpha = hslaMatch[4];
    if (alpha !== undefined) {
      return `${fn}(${hue}, 0%, ${lightness}, ${alpha})`;
    }
    return `${fn}(${hue}, 0%, ${lightness})`;
  }

  // rgba — convert and preserve alpha
  const rgbaMatch = vLower.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1] ?? '0', 10);
    const g = parseInt(rgbaMatch[2] ?? '0', 10);
    const b = parseInt(rgbaMatch[3] ?? '0', 10);
    const a = rgbaMatch[4] ?? '1';
    const gray = toLuminanceGray(r, g, b);
    return `rgba(${gray}, ${gray}, ${gray}, ${a})`;
  }

  // rgb()
  const rgbMatch = vLower.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1] ?? '0', 10);
    const g = parseInt(rgbMatch[2] ?? '0', 10);
    const b = parseInt(rgbMatch[3] ?? '0', 10);
    const gray = toLuminanceGray(r, g, b);
    return grayToHex(gray);
  }

  // Hex colors
  if (v.startsWith('#')) {
    const rgb = parseHex(v);
    if (rgb) {
      const gray = toLuminanceGray(rgb[0], rgb[1], rgb[2]);
      return grayToHex(gray);
    }
    return v;
  }

  // Named colors
  const named = NAMED_COLORS[vLower];
  if (named) {
    const gray = toLuminanceGray(named[0], named[1], named[2]);
    return grayToHex(gray);
  }

  return v;
};

/**
 * Convert all color values in an SVG to luminance-equivalent grays.
 * Processes fill, stroke, stop-color, and flood-color in both attributes and inline styles.
 * Uses ITU-R BT.709: gray = 0.2126*R + 0.7152*G + 0.0722*B
 */
const generateInactiveIcon = (svgContent: string): string => {
  let result = svgContent;

  // Convert attribute values: (fill|stroke|stop-color|flood-color)="value"
  const attrPattern = new RegExp(`((?:${COLOR_ATTRS.join('|')})\\s*=\\s*")([^"]*)(")`, 'gi');
  result = result.replace(attrPattern, (_match, prefix: string, value: string, suffix: string) => {
    const converted = convertColorToGray(value);
    return `${prefix}${converted}${suffix}`;
  });

  // Convert inline style property values
  const stylePattern = /style\s*=\s*"([^"]*)"/gi;
  result = result.replace(stylePattern, (fullMatch, styleValue: string) => {
    let newStyle = styleValue;
    for (const attr of COLOR_ATTRS) {
      const propPattern = new RegExp(`(${attr.replace('-', '\\-')}\\s*:\\s*)([^;"]+)`, 'gi');
      newStyle = newStyle.replace(propPattern, (_m, propPrefix: string, propValue: string) => {
        const converted = convertColorToGray(propValue);
        return `${propPrefix}${converted}`;
      });
    }
    return fullMatch.replace(styleValue, newStyle);
  });

  return result;
};

export { generateInactiveIcon, MAX_ICON_SIZE, validateIconSvg, validateInactiveIconColors };
