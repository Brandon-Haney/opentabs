---
layout: home

hero:
  name: OpenTabs
  text: Give AI agents access to web apps through your browser
  tagline: Zero tokens, full access. Use your existing browser sessions — no API keys, no bot accounts, no admin approval.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/opentabs-dev/opentabs

features:
  - icon: 🔌
    title: Plugin Architecture
    details: Extend OpenTabs with plugins for any web application. Each plugin defines tools that AI agents can use through MCP.
  - icon: 🔐
    title: Your Session, Your Access
    details: Uses your authenticated browser sessions. No API tokens to manage, no bot users to provision, no OAuth flows to configure.
  - icon: 🤖
    title: MCP Native
    details: Works with any MCP-compatible AI agent — Claude Code, Cursor, and more. Tools appear automatically.
  - icon: ⚡
    title: Hot Reload
    details: Change plugin code, rebuild, and tools update instantly. No server restarts, no reconnections needed.
  - icon: 🧩
    title: Build Your Own
    details: Create plugins with the OpenTabs SDK. Define tools with Zod schemas, write adapter code, and ship as an npm package.
  - icon: 🌐
    title: Chrome Extension
    details: Lightweight Manifest V3 extension injects adapters into matching tabs and dispatches tool calls to the right page context.
---
