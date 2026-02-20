import { fixupConfigRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import { flatConfigs as importXFlatConfig } from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import reactPlugin from 'eslint-plugin-react';
import { browser, es2020, node } from 'globals';
import { configs as tseslintConfigs, parser as tseslintParser } from 'typescript-eslint';
import type { FixupConfigArray } from '@eslint/compat';
import type { Linter } from 'eslint';

const config: Linter.Config[] = [
  // Shared configs
  js.configs.recommended,
  ...(tseslintConfigs.strictTypeChecked as Linter.Config[]),
  jsxA11y.flatConfigs.recommended,
  importXFlatConfig.recommended as Linter.Config,
  importXFlatConfig.typescript as Linter.Config,
  eslintPluginPrettierRecommended,
  // React hooks rules scoped to .tsx files
  {
    files: ['**/*.tsx'],
    ...fixupConfigRules(new FlatCompat().extends('plugin:react-hooks/recommended') as FixupConfigArray)[0],
  },
  {
    files: ['**/*.{ts,tsx}'],
    ...reactPlugin.configs.flat.recommended,
    ...reactPlugin.configs.flat['jsx-runtime'],
  },
  // Global ignores
  {
    ignores: ['.next/', '.source/', 'out/', 'node_modules/', 'next-env.d.ts', '**/*.mjs'],
  },
  // Main TypeScript/TSX rules
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslintParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
        projectService: {
          allowDefaultProject: ['eslint.config.ts', 'knip.ts'],
        },
      },
      globals: {
        ...es2020,
        ...browser,
        ...node,
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: false,
          allowAny: false,
          allowNullish: false,
          allowRegExp: false,
          allowNever: false,
        },
      ],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      'func-style': ['error', 'expression', { allowArrowFunctions: true }],
      'arrow-body-style': ['error', 'as-needed'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      'import-x/order': [
        'error',
        {
          'newlines-between': 'never',
          alphabetize: { order: 'asc', caseInsensitive: true },
          groups: ['index', 'sibling', 'parent', 'internal', 'external', 'builtin', 'object', 'type'],
          pathGroups: [
            {
              pattern: '@*/**',
              group: 'internal',
              position: 'before',
            },
          ],
          pathGroupsExcludedImportTypes: ['type'],
        },
      ],
      'import-x/no-unresolved': 'off',
      'import-x/no-named-as-default': 'error',
      'import-x/no-named-as-default-member': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/no-deprecated': 'error',
      'import-x/no-duplicates': ['error', { considerQueryString: true, 'prefer-inline': false }],
      'import-x/consistent-type-specifier-style': 'error',
      'import-x/exports-last': 'error',
      'import-x/first': 'error',
      // Scrollable containers with role="region" and tabIndex={0} are a valid WCAG pattern
      'jsx-a11y/no-noninteractive-tabindex': ['error', { tags: [], roles: ['tabpanel', 'region'] }],
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
];

export default config;
