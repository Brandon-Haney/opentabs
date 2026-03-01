import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  framework: '@storybook/react-vite',
  viteFinal: async viteConfig => {
    const tailwindcss = await import('@tailwindcss/vite');
    const { default: react } = await import('@vitejs/plugin-react');

    // @storybook/react-vite auto-adds @vitejs/plugin-react without babel options.
    // Replace it with a version configured for React Compiler.
    const reactPluginNames = new Set(['vite:react-babel', 'vite:react-refresh', 'vite:react-virtual-preamble']);
    const isNamedPlugin = (p: unknown): p is { name: string } =>
      !!p && !Array.isArray(p) && typeof (p as { name?: string }).name === 'string';

    viteConfig.plugins = [
      ...(viteConfig.plugins ?? []).filter(p => !isNamedPlugin(p) || !reactPluginNames.has(p.name)),
      ...react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
      tailwindcss.default(),
    ];
    return viteConfig;
  },
};

export default config;
