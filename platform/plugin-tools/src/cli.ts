#!/usr/bin/env node

import { registerBuildCommand, registerInspectCommand } from './commands/index.js';
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(await readFile(join(cliDir, '..', 'package.json'), 'utf-8')) as { version: string };

const program = new Command('opentabs-plugin')
  .version(pkgJson.version, '-V, --version')
  .description('OpenTabs plugin tools — build and validate plugins')
  .action(() => {
    program.help();
  });

registerBuildCommand(program);
registerInspectCommand(program);

await program.parseAsync();
