# Plugin Icon Skill

Add or update an SVG icon for an OpenTabs plugin. This skill covers the full workflow: preparing the SVG, placing it correctly, validating constraints, building, and verifying.

---

## How Plugin Icons Work

Plugin icons are **discovered by convention** during `opentabs-plugin build`. There is no `package.json` field or config reference — the build tool looks for `icon.svg` at the **plugin root directory** (next to `package.json`).

### Two Levels of Icons

1. **Plugin-level SVG icon** (`icon.svg`) — displayed in the side panel next to the plugin name. This is what this skill covers.
2. **Per-tool Lucide icon** (`icon` property in `defineTool()`) — a Lucide icon name string for each individual tool. Separate concern, not covered here.

### Icon Pipeline

```
icon.svg (plugin root)
  → opentabs-plugin build (validates, minifies, auto-generates inactive variant)
    → dist/tools.json (embedded as iconSvg / iconInactiveSvg string fields)
      → MCP server loads from tools.json
        → sent to Chrome extension via WebSocket
          → rendered in side panel (PluginIcon.tsx)
```

### Fallback

Plugins without an `icon.svg` fall back to a **letter avatar** — the first letter of the plugin's `displayName` with a deterministic color based on the plugin name.

---

## SVG Requirements

The build tool (`platform/plugin-tools/src/validate-icon.ts`) enforces these constraints:

| Constraint | Rule |
|---|---|
| **File size** | <= 8 KB |
| **viewBox** | Must be present |
| **viewBox shape** | Must be **square** (width === height) |
| **Forbidden elements** | No `<image>`, no `<script>` |
| **Forbidden attributes** | No event handlers (`onclick`, `onload`, etc.) |

The extension also runs an allowlist-based SVG sanitizer (`platform/browser-extension/src/sanitize-svg.ts`) that strips any elements/attributes not on the allowlist.

---

## Workflow

### Step 1: Obtain the Source SVG

Get the brand SVG from the service's official brand assets page. Prefer:
- The **icon-only** variant (no wordmark/lockup)
- A **single-color** version (works best at small sizes)
- The **dark/black** variant (the side panel has a light background)

**Watch out for fake SVGs**: Some brand asset downloads are rasterized PNGs embedded inside an SVG wrapper (using `<image>` with a base64 `data:image/png` href). These fail validation because `<image>` elements are forbidden. Always inspect the SVG source — a real vector SVG contains `<path>`, `<circle>`, `<rect>`, etc., not `<image>`.

#### Fallback: Simple Icons

If the official brand assets don't provide a usable vector SVG (or only provide rasterized versions), use the **Simple Icons** project as a fallback. It has high-quality vector SVGs for thousands of brands, all with square `24x24` viewBoxes:

```
https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/<name>.svg
```

Use WebFetch to download the SVG directly:
```
WebFetch("https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/<name>.svg", format: "text")
```

The returned SVG needs minor cleanup:
- Remove `role="img"` from the `<svg>` element
- Remove the `<title>` element
- Add `fill="black"` to the `<path>` (Simple Icons paths have no fill, defaulting to black in most renderers, but explicit is better)
- The viewBox is already square (`0 0 24 24`), so no adjustment needed

Simple Icons are licensed under CC0 (public domain dedication).

### Step 2: Prepare the SVG

Common issues to fix:

#### Non-Square viewBox

This is the most common issue. Brand SVGs often have non-square viewBoxes (e.g., `0 0 98 96`).

**The correct fix is to expand the viewBox to a square and center the content using the `min-x`/`min-y` offset — never stretch or scale the paths.**

For a viewBox of `0 0 W H` where `W > H`:
```
viewBox="0 -(W-H)/2 W W"
```

For a viewBox of `0 0 W H` where `H > W`:
```
viewBox="-(H-W)/2 0 H H"
```

Example: `0 0 98 96` (2px taller than wide) becomes `viewBox="0 -1 98 98"`.

This shifts the coordinate system origin so the original content is centered in the new square viewBox. No path data modification needed, no distortion.

**Alternative approach** — wrap content in a `<g>` with a translate transform:
```xml
<svg viewBox="0 0 98 98" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(0, 1)">
    <!-- original paths -->
  </g>
</svg>
```

Both are correct. The `min-x`/`min-y` offset approach is simpler (fewer elements).

#### Unnecessary Attributes

Remove from the `<svg>` element:
- `width` and `height` (the icon system sizes icons via CSS, not SVG attributes)
- `fill="none"` on the root `<svg>` (only if it interferes with child rendering)
- Figma/Illustrator metadata (`data-name`, comments, etc.)

Keep:
- `xmlns="http://www.w3.org/2000/svg"` (required)
- `viewBox` (required)
- `fill="none"` on the root if paths use their own explicit fills

#### Clip Paths

If the original SVG has a `<clipPath>` that clips to the original non-square dimensions, and you expanded the viewBox, the clip path may cut off centered content. Evaluate whether the clip path is actually needed — often brand icons have clip paths that match the original bounding box exactly and can be removed when the content doesn't overflow.

#### File Size

If the SVG exceeds 8 KB:
- Remove comments, metadata, and unnecessary whitespace
- Simplify paths if possible (reduce decimal precision)
- Remove redundant `<g>` wrappers
- The build tool minifies automatically, so light whitespace is fine

### Step 3: Place the Icon

Place the prepared SVG at the plugin root:

```
plugins/<name>/icon.svg
```

### Step 4: Optional — Provide a Custom Inactive Icon

The build tool auto-generates `iconInactiveSvg` by converting all colors to luminance-equivalent grays (ITU-R BT.709). This works well for most icons.

If you want a custom inactive variant, place it at:

```
plugins/<name>/icon-inactive.svg
```

Requirements for custom inactive icons:
- Must use **only achromatic colors** (grays, black, white) — no saturated colors
- Same structural constraints as `icon.svg` (size, viewBox, no forbidden elements)

### Step 5: Build

```bash
cd plugins/<name>
npm run build
```

The build output confirms icon discovery:

```
Plugin icon: icon.svg found, auto-generating inactive variant
```

If validation fails, the build reports specific errors (e.g., "SVG viewBox must be square").

### Step 6: Verify

1. Check the icon is embedded in `dist/tools.json`:
   ```bash
   node -e "const m = require('./dist/tools.json'); console.log('iconSvg:', !!m.iconSvg, 'iconInactiveSvg:', !!m.iconInactiveSvg)"
   ```

2. Open the Chrome extension side panel and verify the icon renders correctly for the plugin (both active/ready state and inactive/unavailable state).


