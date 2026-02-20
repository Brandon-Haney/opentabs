# Browser Extension Instructions

## Overview

Chrome extension (Manifest V3) that connects the MCP server to web pages. Receives plugin definitions via WebSocket, injects adapter IIFEs into matching tabs, and dispatches tool calls. Includes a React side panel UI for plugin management.

## Key Directories

```
platform/browser-extension/
├── src/
│   ├── background.ts              # Service worker — WebSocket, adapter injection, tool dispatch
│   ├── offscreen/                  # Persistent WebSocket (MV3 workaround)
│   └── side-panel/                 # React side panel UI
│       ├── styles.css              # THE theme definition — single source of truth
│       ├── App.tsx                 # Root component
│       ├── components/
│       │   ├── retro/              # RetroUI primitives (Button, Badge, Switch, Accordion, etc.)
│       │   └── *.tsx               # App-specific components (PluginCard, ToolRow, etc.)
│       └── hooks/                  # React hooks
├── build-side-panel.ts             # Bun.build script for side panel
├── build-extension.ts              # Bun.build script for background + offscreen
└── manifest.json                   # Extension manifest
```

---

## The Theme Is the Design System

`src/side-panel/styles.css` defines the complete visual language — colors, radius, shadows, and fonts — as CSS custom properties. The `@theme` block bridges these to Tailwind utility classes. **The theme is not a suggestion. It is the specification.** Every component must reference theme tokens; nothing may be hardcoded or overridden by aesthetic preference.

### Respect the theme. Always.

- **Use theme-aware Tailwind classes for everything.** Colors (`bg-primary`, `text-foreground`, `border-border`), radius (`rounded`), shadows (`shadow-md`), fonts (`font-head`, `font-sans`, `font-mono`). These classes resolve to CSS variables defined in `styles.css`.
- **Never hardcode values that the theme provides.** No hex colors in className strings. No Tailwind default palette colors (`bg-yellow-400`, `text-gray-500`). No inline style color/radius overrides. No arbitrary values (`bg-[#ffdb33]`, `rounded-[8px]`). If a value exists as a theme variable, use the corresponding Tailwind class.
- **Never override the theme's aesthetic choices.** The theme defines `--radius: 0.5rem` — every bordered container uses `rounded`. The theme defines flat offset shadows — every card uses `shadow-md`. Do not substitute different values because they "look better" or "feel more appropriate for the style." The design system is intentional and internally consistent.
- **Never change theme variable values** in `:root` or `.dark` without explicit approval from the user. These values are the brand identity.

### The theme at a glance

The full definitions live in `styles.css`. Key tokens:

| Token          | Light     | Dark      | Tailwind class    |
| -------------- | --------- | --------- | ----------------- |
| `--radius`     | `0.5rem`  | (same)    | `rounded`         |
| `--background` | `#fff`    | `#1a1a1a` | `bg-background`   |
| `--foreground` | `#000`    | `#f5f5f5` | `text-foreground` |
| `--primary`    | `#ffdb33` | `#ffdb33` | `bg-primary`      |
| `--border`     | `#000`    | `#5c5c5c` | `border-border`   |
| `--card`       | `#fff`    | `#242424` | `bg-card`         |
| `--muted`      | `#cccccc` | `#3f3f46` | `bg-muted`        |

Shadows are flat offsets using `var(--border)` — no blur, no spread. Fonts: `font-head` (Archivo Black), `font-sans` (Space Grotesk), `font-mono` (Space Mono).

### Component pattern

Every bordered container in this design system follows the same recipe:

```
rounded border-2 border-border bg-card shadow-md
```

Interactive containers add a press-down hover effect:

```
transition-all hover:translate-y-0.5 hover:shadow
```

If a component has `border-2`, it should also have `rounded`. If it has `shadow-md`, it should use the theme shadow (which already references `var(--border)`). There are no exceptions to this pattern.

### Shared theme with docs site

The side panel theme (`styles.css`) and the docs theme (`docs/app/global.css`) share the same design system. The core tokens (colors, radius, shadows, fonts) must stay in sync. If one changes, the other must be updated to match.

---

## Sizing Constraints

The side panel runs inside a Chrome extension popup with limited viewport width. Elements nested inside fixed-height containers (e.g., a button inside a header bar) must respect their parent's dimensions. Do not apply blanket sizing rules (like 44px touch targets) to elements inside constrained containers — this causes overflow.
