#!/usr/bin/env bun

import { scaffoldPlugin, ScaffoldError } from '@opentabs-dev/cli/scaffold';
import { Command } from 'commander';
import pc from 'picocolors';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(await Bun.file(join(cliDir, '..', 'package.json')).text()) as { version: string };

const program = new Command('create-opentabs-plugin')
  .version(pkgJson.version, '-V, --version')
  .description('Scaffold a new OpenTabs plugin project')
  .argument('<name>', 'Plugin name (lowercase alphanumeric + hyphens)')
  .requiredOption('--domain <domain>', 'Target domain (e.g., .slack.com or github.com)')
  .option('--display <name>', 'Display name (e.g., Slack)')
  .option('--description <desc>', 'Plugin description')
  .action(async (name: string, options: { domain: string; display?: string; description?: string }) => {
    try {
      await scaffoldPlugin({
        name,
        domain: options.domain,
        display: options.display,
        description: options.description,
      });
    } catch (err: unknown) {
      if (err instanceof ScaffoldError) {
        console.error(pc.red(`Error: ${err.message}`));
        process.exit(1);
      }
      throw err;
    }
  });

await program.parseAsync();
