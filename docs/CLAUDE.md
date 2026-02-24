# Docs Project Instructions

## Overview

The OpenTabs documentation site is built with Next.js 16, content-collections for MDX, and a neo-brutalist design system. Content is authored in MDX under `content/`, rendered via content-collections, and styled with Tailwind CSS 4.

## Tech Stack

- **Framework:** Next.js 16 (static export via `next build`)
- **Content:** content-collections (`@content-collections/mdx` + `@content-collections/next`)
- **Styling:** Tailwind CSS 4 (CSS-first config via `@theme inline` in `global.css`)
- **UI primitives:** Radix UI (Slot), Headless UI (Tabs)
- **Fonts:** Archivo Black (headings), Space Grotesk (body), Space Mono (code)

## Commands

```bash
bun run build         # next build (static export)
bun run type-check    # tsc --noEmit
bun run lint          # eslint
bun run knip          # unused code detection
bun run format:check  # prettier check
bun run check         # All checks (build + type-check + lint + knip + format:check)
```

All checks must pass. This project has no test suite. `bun run check` runs them all sequentially, stopping on first failure.

From the repo root, these convenience aliases are available:

```bash
bun run dev:docs        # next dev (docs dev server)
bun run build:docs      # next build
bun run lint:docs       # eslint
bun run type-check:docs # tsc --noEmit
bun run check:docs      # All docs checks from root
```

## Directory Structure

```
docs/
├── app/
│   ├── global.css              # Theme definition — single source of truth
│   ├── layout.tsx              # Root layout (fonts, Provider)
│   ├── page.tsx                # Homepage
│   └── docs/                   # Docs pages layout
├── components/
│   ├── retroui/                # RetroUI primitives (Button, Badge, Table, etc.)
│   ├── illustrations.tsx       # All SVG illustration components
│   ├── MDX.tsx                 # MDX component overrides and illustration registration
│   ├── CodeBlock.tsx           # Code block with copy button
│   └── global-header.tsx       # Shared header across all pages
├── content/
│   └── docs/                   # MDX content files (guides, SDK reference, etc.)
├── config/                     # Content-collections and docs configuration
├── lib/
│   └── utils.ts                # cn() helper
└── types/                      # TypeScript type definitions
```

## Theme

`app/global.css` defines the visual language as CSS custom properties. Key tokens:

| Token          | Light     | Dark      | Tailwind class    |
| -------------- | --------- | --------- | ----------------- |
| `--radius`     | `0`       | (same)    | `rounded`         |
| `--background` | `#fff`    | `#1a1a1a` | `bg-background`   |
| `--foreground` | `#000`    | `#f5f5f5` | `text-foreground` |
| `--primary`    | `#ffdb33` | `#ffdb33` | `bg-primary`      |
| `--border`     | `#000`    | `#5c5c5c` | `border-border`   |
| `--card`       | `#fff`    | `#242424` | `bg-card`         |

Shadows are flat offsets using `var(--border)` with no blur or spread.

## SVG Illustrations

All illustrations live in `docs/components/illustrations.tsx` and are registered in `docs/components/MDX.tsx` for use in `.mdx` files.

### Design Rules

- CSS variables for theming: `var(--color-foreground)`, `var(--color-primary)`, `var(--color-background)`
- Font: `var(--font-mono), monospace` for all text
- Borders: 3px `strokeWidth` on main containers
- Shadows: Hard drop shadow via offset `<rect>` (4px right, 4px down) filled with `var(--color-foreground)`
- Headers: Box-with-header-bar pattern — header filled with `var(--color-foreground)`, text in `var(--color-primary)` bold
- No border-radius (`--radius: 0`)
- Arrow markers: Triangular arrowheads filled with `var(--color-foreground)`, unique IDs per illustration (e.g., `pf-arrow`, `fp-arrow`)
- Muted labels: `opacity="0.4"` to `0.5"` for secondary text
- Highlighted items: `var(--color-primary)` with `opacity="0.12"` fill and `1.5px` stroke
- Dashed borders: `strokeDasharray="4 3"` for optional/repeating elements
- Accessibility: `aria-hidden="true"` on `<svg>` elements

### Current Illustrations

| Component                  | Used on                                           | Concept                               |
| -------------------------- | ------------------------------------------------- | ------------------------------------- |
| `ArchitectureIllustration` | `docs/content/docs/contributing/architecture.mdx` | 3-component platform architecture     |
| `QuickStartFlow`           | `docs/content/docs/quick-start.mdx`               | Quick start installation steps        |
| `ConfigDirectory`          | `docs/content/docs/reference/configuration.mdx`   | Config directory tree structure       |
| `MonorepoStructure`        | `docs/content/docs/contributing/dev-setup.mdx`    | Monorepo project layout               |
| `DispatchFlow`             | `docs/content/docs/guides/resources-prompts.mdx`  | Resource and prompt dispatch pipeline |
| `PluginStructure`          | `docs/content/docs/guides/plugin-development.mdx` | Plugin directory structure            |
| `ProgressFlow`             | `docs/content/docs/guides/streaming-progress.mdx` | 6-step progress notification pipeline |
| `LifecycleSequence`        | `docs/content/docs/sdk/lifecycle-hooks.mdx`       | Lifecycle hooks execution timeline    |
| `ErrorCategories`          | `docs/content/docs/guides/error-handling.mdx`     | Error categories and retry behavior   |
| `HowItWorks`               | `docs/content/docs/index.mdx`                     | 3-step runtime flow overview          |
| `InstallPaths`             | `docs/content/docs/install/index.mdx`             | Three installation path options       |
| `FirstPluginFlow`          | `docs/content/docs/first-plugin.mdx`              | 5-step plugin creation workflow       |

## Documentation Tone

The docs follow a progressive audience path: **normal user** (Quick Start, Installation) → **plugin developer** (Guides, SDK Reference) → **platform contributor** (Contributing). The tone is:

- **Friendly and accessible** — no jargon without explanation, no assumptions about prior knowledge
- **Step-by-step and hand-holding** — explicit numbered steps, one action per step
- **Show before tell** — lead with a visual or code example, then explain
- **Concrete over abstract** — real commands, real output, real file paths

Illustrations should match this tone: clear, labeled, approachable. Prefer showing the "happy path" flow over comprehensive architecture diagrams. Use annotations and labels generously.
