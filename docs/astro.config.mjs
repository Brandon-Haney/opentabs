import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  integrations: [
    starlight({
      title: 'OpenTabs',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/opentabs-dev/opentabs',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/opentabs-dev/opentabs/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'Guide',
          items: [
            {
              label: 'Introduction',
              items: [
                { label: 'What is OpenTabs?', slug: 'guide/what-is-opentabs' },
                { label: 'Getting Started', slug: 'guide/getting-started' },
                { label: 'How It Works', slug: 'guide/how-it-works' },
              ],
            },
            {
              label: 'Setup',
              items: [
                {
                  label: 'Install the Extension',
                  slug: 'guide/install-extension',
                },
                { label: 'Start the MCP Server', slug: 'guide/mcp-server' },
                { label: 'Connect to Claude Code', slug: 'guide/connect-claude' },
              ],
            },
            {
              label: 'Using Plugins',
              items: [
                { label: 'Install a Plugin', slug: 'guide/install-plugin' },
                {
                  label: 'Plugin Configuration',
                  slug: 'guide/plugin-config',
                },
              ],
            },
          ],
        },
        {
          label: 'Plugins',
          items: [
            { label: 'Overview', slug: 'plugins/overview' },
            { label: 'Creating a Plugin', slug: 'plugins/creating-a-plugin' },
            { label: 'Plugin SDK', slug: 'plugins/sdk' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'reference/config' },
            { label: 'CLI', slug: 'reference/cli' },
          ],
        },
      ],
      customCss: ['./src/styles/global.css'],
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.googleapis.com',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.gstatic.com',
            crossorigin: '',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@300..700&display=swap',
          },
        },
      ],
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
