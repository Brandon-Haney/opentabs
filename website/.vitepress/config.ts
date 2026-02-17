import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'OpenTabs',
  description: 'Give AI agents access to web apps through your browser. Zero tokens, full access.',

  head: [
    ['meta', { name: 'theme-color', content: '#3451b2' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'OpenTabs' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-opentabs' },
      { text: 'Plugins', link: '/plugins/overview' },
      { text: 'Reference', link: '/reference/config' },
      {
        text: 'Links',
        items: [
          { text: 'GitHub', link: 'https://github.com/opentabs-dev/opentabs' },
          { text: 'Chrome Web Store', link: '#' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is OpenTabs?', link: '/guide/what-is-opentabs' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'How It Works', link: '/guide/how-it-works' },
          ],
        },
        {
          text: 'Setup',
          items: [
            { text: 'Install the Extension', link: '/guide/install-extension' },
            { text: 'Start the MCP Server', link: '/guide/mcp-server' },
            { text: 'Connect to Claude Code', link: '/guide/connect-claude' },
          ],
        },
        {
          text: 'Using Plugins',
          items: [
            { text: 'Install a Plugin', link: '/guide/install-plugin' },
            { text: 'Plugin Configuration', link: '/guide/plugin-config' },
          ],
        },
      ],
      '/plugins/': [
        {
          text: 'Plugins',
          items: [
            { text: 'Overview', link: '/plugins/overview' },
            { text: 'Creating a Plugin', link: '/plugins/creating-a-plugin' },
            { text: 'Plugin SDK', link: '/plugins/sdk' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Configuration', link: '/reference/config' },
            { text: 'CLI', link: '/reference/cli' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/opentabs-dev/opentabs' }],

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/opentabs-dev/opentabs/edit/main/website/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025-present OpenTabs',
    },
  },
});
