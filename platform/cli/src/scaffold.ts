/**
 * Shared scaffolding logic for creating new OpenTabs plugin projects.
 * Used by both `opentabs plugin create` and `create-opentabs-plugin`.
 *
 * Plugins are always standalone projects that depend on published
 * `@opentabs-dev/*` npm packages. There is no monorepo special-casing.
 */

import { getConfigPath, readConfig } from './config.js';
import { validatePluginName, validateUrlPattern } from '@opentabs-dev/plugin-sdk';
import pc from 'picocolors';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';

// --- Errors ---

class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

// --- Types ---

interface ScaffoldArgs {
  name: string;
  domain: string;
  display?: string;
  description?: string;
}

// --- Template generation ---

/** Resolve the current version of an @opentabs-dev package from the installed CLI. */
const resolvePackageVersion = async (packageSpecifier: string): Promise<string> => {
  try {
    const entryUrl = import.meta.resolve(packageSpecifier);
    const entryDir = dirname(new URL(entryUrl).pathname);
    const pkg: unknown = await Bun.file(join(entryDir, '..', 'package.json')).json();
    if (pkg !== null && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') {
      return `^${pkg.version}`;
    }
    return '^0.0.2';
  } catch {
    return '^0.0.2';
  }
};

const generatePackageJson = async (args: ScaffoldArgs): Promise<string> => {
  const [sdkVersion, cliVersion] = await Promise.all([
    resolvePackageVersion('@opentabs-dev/plugin-sdk'),
    resolvePackageVersion('@opentabs-dev/cli'),
  ]);

  const pkg = {
    name: `opentabs-plugin-${args.name}`,
    version: '0.0.1',
    type: 'module',
    keywords: ['opentabs-plugin'],
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    },
    types: './dist/index.d.ts',
    files: ['dist', 'opentabs-plugin.json'],
    scripts: {
      build: 'tsc && opentabs build',
      dev: 'bun run build --watch',
      'type-check': 'tsc --noEmit',
      lint: 'eslint src/',
      'lint:fix': 'eslint src/ --fix',
      'format:check': 'prettier --check "src/**/*.ts"',
      format: 'prettier --write "src/**/*.ts"',
    },
    peerDependencies: {
      zod: '^3.0.0',
    },
    dependencies: {
      '@opentabs-dev/plugin-sdk': sdkVersion,
    },
    devDependencies: {
      '@opentabs-dev/cli': cliVersion,
      eslint: '^9.39.2',
      'eslint-config-prettier': '^10.1.8',
      'eslint-plugin-prettier': '^5.5.5',
      jiti: '^2.4.2',
      prettier: '^3.8.1',
      typescript: '^5.9.3',
      'typescript-eslint': '^8.55.0',
      zod: '^3.0.0',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
};

const TSCONFIG_CONTENT =
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        noUncheckedIndexedAccess: true,
        noFallthroughCasesInSwitch: true,
        noImplicitReturns: true,
        noImplicitOverride: true,
        forceConsistentCasingInFileNames: true,
        esModuleInterop: true,
        skipLibCheck: true,
        composite: true,
      },
      include: ['src'],
    },
    null,
    2,
  ) + '\n';

const ESLINT_CONFIG_CONTENT = `import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.strict,
  eslintPluginPrettierRecommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
`;

const PRETTIERRC_CONTENT =
  JSON.stringify(
    {
      trailingComma: 'all',
      semi: true,
      singleQuote: true,
      arrowParens: 'avoid',
      printWidth: 120,
    },
    null,
    2,
  ) + '\n';

const GITIGNORE_CONTENT = `dist/
node_modules/
*.tsbuildinfo
bun.lock
`;

/** Convert a hyphenated name to PascalCase: "my-plugin" → "MyPlugin" */
const toPascalCase = (name: string): string =>
  name
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const generatePluginIndex = (args: ScaffoldArgs, urlPattern: string): string => {
  const displayName = args.display ?? args.name.charAt(0).toUpperCase() + args.name.slice(1);
  const desc = args.description ?? `OpenTabs plugin for ${displayName}`;

  return `import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import { exampleTool } from './tools/example.js';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';

class ${toPascalCase(args.name)}Plugin extends OpenTabsPlugin {
  readonly name = ${JSON.stringify(args.name)};
  readonly version = '0.0.1';
  readonly description = ${JSON.stringify(desc)};
  override readonly displayName = ${JSON.stringify(displayName)};
  readonly urlPatterns = [${JSON.stringify(urlPattern)}];
  readonly tools: ToolDefinition[] = [exampleTool];

  // Check if the user is authenticated on the target page.
  // Example: look for a session cookie, a logged-in DOM element, or a
  // global variable set by the application after login.
  //   return document.cookie.includes('session=')
  //   return document.querySelector('[data-user-id]') !== null
  async isReady(): Promise<boolean> {
    return true;
  }
}

export default new ${toPascalCase(args.name)}Plugin();
`;
};

const generateExampleTool = (args: ScaffoldArgs): string => {
  const displayName = args.display ?? args.name.charAt(0).toUpperCase() + args.name.slice(1);

  const escaped = JSON.stringify(displayName);

  return `import { z } from 'zod';
import { defineTool } from '@opentabs-dev/plugin-sdk';

export const exampleTool = defineTool({
  name: 'example',
  description: 'An example tool for ' + ${escaped} + ' — replace with your own implementation',
  input: z.object({
    message: z.string().describe('A sample input message'),
  }),
  output: z.object({
    result: z.string().describe('The result of the example operation'),
  }),
  handle: async (params) => {
    return { result: 'Hello from ' + ${escaped} + ': ' + params.message };
  },
});
`;
};

// --- Auto-registration ---

/**
 * Add a plugin path to ~/.opentabs/config.json.
 * Uses a relative path from the config directory for portability.
 * Non-fatal: logs a warning on failure.
 */
const autoRegisterPlugin = async (projectDir: string): Promise<boolean> => {
  const configPath = getConfigPath();
  let config: Record<string, unknown>;

  const existing = await readConfig(configPath);
  if (existing) {
    config = existing;
  } else {
    const configDir = dirname(configPath);
    mkdirSync(configDir, { recursive: true });
    config = { plugins: [], tools: {}, secret: crypto.randomUUID() };
  }

  if (!Array.isArray(config.plugins)) config.plugins = [];
  const plugins = config.plugins as string[];

  const configDir = dirname(configPath);
  const pluginPath = relative(configDir, projectDir);

  if (plugins.includes(pluginPath)) return true;

  plugins.push(pluginPath);
  await Bun.write(configPath, JSON.stringify(config, null, 2) + '\n');
  return true;
};

// --- Scaffolding ---

/**
 * Scaffold a new OpenTabs plugin project.
 * Returns the absolute path to the created project directory.
 */
const scaffoldPlugin = async (args: ScaffoldArgs): Promise<string> => {
  const nameError = validatePluginName(args.name);
  if (nameError) {
    throw new ScaffoldError(nameError);
  }

  const urlPattern = args.domain.startsWith('.') ? `*://*${args.domain}/*` : `*://${args.domain}/*`;
  const patternError = validateUrlPattern(urlPattern);
  if (patternError) {
    throw new ScaffoldError(patternError);
  }

  const projectDir = resolve(process.cwd(), args.name);
  if (existsSync(projectDir)) {
    throw new ScaffoldError(`Directory "${args.name}" already exists`);
  }

  console.log(`Creating ${pc.bold(`opentabs-plugin-${args.name}`)}...`);

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, 'src', 'tools'), { recursive: true });

  await Bun.write(join(projectDir, 'package.json'), await generatePackageJson(args));
  console.log(`  ${pc.dim('Created:')} ${pc.bold('package.json')}`);

  await Bun.write(join(projectDir, 'tsconfig.json'), TSCONFIG_CONTENT);
  console.log(`  ${pc.dim('Created:')} ${pc.bold('tsconfig.json')}`);

  await Bun.write(join(projectDir, 'eslint.config.ts'), ESLINT_CONFIG_CONTENT);
  console.log(`  ${pc.dim('Created:')} ${pc.bold('eslint.config.ts')}`);

  await Bun.write(join(projectDir, '.prettierrc'), PRETTIERRC_CONTENT);
  console.log(`  ${pc.dim('Created:')} ${pc.bold('.prettierrc')}`);

  await Bun.write(join(projectDir, '.gitignore'), GITIGNORE_CONTENT);
  console.log(`  ${pc.dim('Created:')} ${pc.bold('.gitignore')}`);

  await Bun.write(join(projectDir, 'src', 'index.ts'), generatePluginIndex(args, urlPattern));
  console.log(`  ${pc.dim('Created:')} ${pc.bold('src/index.ts')}`);

  await Bun.write(join(projectDir, 'src', 'tools', 'example.ts'), generateExampleTool(args));
  console.log(`  ${pc.dim('Created:')} ${pc.bold('src/tools/example.ts')}`);

  console.log('');
  console.log(pc.green(`Plugin scaffolded in ./${args.name}/`));

  try {
    await autoRegisterPlugin(projectDir);
    console.log(pc.green('Registered in ~/.opentabs/config.json'));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(pc.yellow(`Warning: Could not auto-register plugin: ${msg}`));
    console.warn(`  Run ${pc.cyan(`opentabs plugin add ./${args.name}`)} manually.`);
  }

  console.log('');
  console.log('Next steps:');
  console.log(`  ${pc.cyan(`cd ${args.name}`)}`);
  console.log(`  ${pc.cyan('bun install')}`);
  console.log(`  ${pc.cyan('bun run build')}`);

  return projectDir;
};

export { scaffoldPlugin, ScaffoldError };
export type { ScaffoldArgs };
