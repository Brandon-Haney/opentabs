/**
 * `opentabs setup` command — copies the browser extension to ~/.opentabs/extension/.
 */

import { EXTENSION_COPY_EXCLUDE_PATTERN } from '@opentabs-dev/shared';
import pc from 'picocolors';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';

const resolveExtensionDir = (): string => {
  try {
    return dirname(fileURLToPath(import.meta.resolve('@opentabs-dev/browser-extension/package.json')));
  } catch {
    const cliDir = dirname(fileURLToPath(import.meta.url));
    return resolve(cliDir, '..', '..', '..', 'browser-extension');
  }
};

const handleSetup = async (): Promise<void> => {
  const extensionSrc = resolveExtensionDir();

  // Verify the extension source exists
  if (!(await Bun.file(join(extensionSrc, 'manifest.json')).exists())) {
    console.error(pc.red(`Error: Browser extension not found at ${extensionSrc}`));
    console.error('Run bun run build from the project root to build the extension.');
    process.exit(1);
  }

  // Read the CLI package version
  const cliPkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  const pkgJson = JSON.parse(await Bun.file(cliPkgPath).text()) as { version: string };
  const version = pkgJson.version;

  const extensionDest = join(homedir(), '.opentabs', 'extension');
  const isUpdate = existsSync(extensionDest);

  if (isUpdate) {
    console.log(pc.dim('Updating existing installation...'));
  }

  // Copy extension directory, skipping node_modules, src, .git, tsconfig*
  cpSync(extensionSrc, extensionDest, {
    recursive: true,
    force: true,
    filter: (source: string) => {
      const rel = relative(extensionSrc, source);
      return rel === '' || !EXTENSION_COPY_EXCLUDE_PATTERN.test(rel);
    },
  });

  // Create adapters directory for plugins
  mkdirSync(join(extensionDest, 'adapters'), { recursive: true });

  // Write version marker
  await Bun.write(join(extensionDest, '.opentabs-version'), version);

  // Verify installation
  if (!existsSync(join(extensionDest, 'manifest.json'))) {
    console.error(pc.red('Error: Installation verification failed — manifest.json missing from destination.'));
    process.exit(1);
  }

  console.log(pc.green(`Extension installed to ${extensionDest} (v${version})`));
  console.log('');
  console.log('To load the extension in Chrome:');
  console.log(`  1. Open ${pc.cyan('chrome://extensions/')}`);
  console.log(`  2. Enable "Developer mode" (top-right toggle)`);
  console.log(`  3. Click "Load unpacked" and select: ${pc.cyan(extensionDest)}`);
};

export const registerSetupCommand = (program: Command): void => {
  program
    .command('setup')
    .description('Install the browser extension to ~/.opentabs/')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs setup`,
    )
    .action(() => handleSetup());
};
