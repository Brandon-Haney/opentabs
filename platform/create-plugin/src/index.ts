#!/usr/bin/env node

import { scaffoldPlugin, promptForMissingArgs, ScaffoldError } from '@opentabs-dev/cli/scaffold';
import { Command } from 'commander';
import pc from 'picocolors';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(await readFile(join(cliDir, '..', 'package.json'), 'utf-8')) as { version: string };

const program = new Command('create-opentabs-plugin')
  .version(pkgJson.version, '-V, --version')
  .description('Scaffold a new OpenTabs plugin project')
  .argument('[name]', 'Plugin name (lowercase alphanumeric + hyphens)')
  .option('--domain <domain>', 'Target domain (e.g., .slack.com or github.com)')
  .option('--display <name>', 'Display name (e.g., Slack)')
  .option('--description <desc>', 'Plugin description')
  .action(async (name: string | undefined, options: { domain?: string; display?: string; description?: string }) => {
    try {
      const args = await promptForMissingArgs({
        name,
        domain: options.domain,
        display: options.display,
        description: options.description,
      });
      await scaffoldPlugin(args);
    } catch (err: unknown) {
      if (err instanceof ScaffoldError) {
        console.error(pc.red(`Error: ${err.message}`));
        process.exit(1);
      }
      throw err;
    }
  });

await program.parseAsync();
