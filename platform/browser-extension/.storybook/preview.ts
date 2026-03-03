import './chrome-mock.mjs';
import './preview.css';
import type { Preview } from '@storybook/react';
import { createElement } from 'react';
import { Tooltip } from '../src/side-panel/components/retro/Tooltip';

const preview: Preview = {
  parameters: {
    layout: 'centered',
    backgrounds: { disable: true },
  },
  globalTypes: {
    theme: {
      description: 'Side panel theme',
      toolbar: {
        title: 'Theme',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'light',
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme as string;
      document.documentElement.classList.toggle('dark', theme === 'dark');
      return createElement(Tooltip.Provider, null, Story());
    },
  ],
};

export default preview;
