# Setup Plugin Skill — Maintenance Guide

## File Structure

```
.claude/skills/setup-plugin/
├── SKILL.md          # Stub with frontmatter (loaded by AI clients at session start)
├── __SKILL__.md      # Actual skill content (read on-demand for latest version)
└── CLAUDE.md         # This file — maintenance instructions
```

## How It Works

AI clients load `SKILL.md` once at session start and cache its frontmatter + content in memory. To ensure the AI always gets the latest skill instructions (even if the skill was updated after the session started), `SKILL.md` is a lightweight stub that tells the AI to read `__SKILL__.md` at execution time.

- **`SKILL.md`**: Contains only the YAML frontmatter (name, description, triggers) and an instruction to read `__SKILL__.md`. Do NOT put actual skill logic here.
- **`__SKILL__.md`**: Contains the full skill instructions — the 7-step setup workflow (search, install, verify, review, test, configure permissions, summary) plus the Quick Start Reference (installation, MCP client configuration, permission model, tool categories). This is the file to edit when updating the skill.

## Updating the Skill

When you need to update the setup-plugin skill content:

1. **Edit `__SKILL__.md`** — this is the single source of truth for skill behavior
2. **Do NOT edit `SKILL.md`** unless you need to change the skill's name, description, or trigger keywords in the frontmatter
3. Changes to `__SKILL__.md` take effect immediately for any AI session that invokes the skill, since the AI reads it fresh each time

## Content Sources

This skill was created by combining two MCP server sources:

- **setup_plugin prompt** (`platform/mcp-server/src/prompts/setup-plugin.ts`) — 8-step setup workflow (steps 1-7 preserved, step 8 "write learnings" replaced with self-update instructions)
- **quick-start resource** (`platform/mcp-server/src/resources/quick-start.ts`) — installation, MCP client configuration (Claude Code, Cursor, Windsurf, OpenCode), plugin discovery, review flow, permission model, tool categories, multi-tab targeting, verification commands

When discovering new setup patterns or common issues during plugin installation, add them directly to `__SKILL__.md` in the appropriate section.
