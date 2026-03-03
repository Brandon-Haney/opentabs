/**
 * `opentabs-plugin inspect` command — pretty-prints the built plugin manifest.
 * Reads dist/tools.json and package.json from the current directory and displays
 * a human-readable summary of tools.
 */

import { TOOLS_FILENAME, parsePluginPackageJson } from '@opentabs-dev/shared';
import pc from 'picocolors';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManifestTool } from '@opentabs-dev/shared';
import type { Command } from 'commander';

/** Shape of dist/tools.json as written by `opentabs-plugin build` */
interface ToolsJsonManifest {
  sdkVersion?: string;
  tools: ManifestTool[];
}

/** Extract field names and types from a JSON Schema object */
const extractFields = (schema: Record<string, unknown>): Array<{ name: string; type: string; required: boolean }> => {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return [];

  const requiredSet = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

  return Object.entries(properties).map(([name, prop]) => {
    let type = 'unknown';
    if (typeof prop.type === 'string') {
      type = prop.type;
    } else if (Array.isArray(prop.anyOf)) {
      const types = (prop.anyOf as Array<Record<string, unknown>>)
        .map(t => (typeof t.type === 'string' ? t.type : '?'))
        .join(' | ');
      type = types;
    }
    return { name, type, required: requiredSet.has(name) };
  });
};

/** Truncate a string to maxLen, appending "..." if truncated */
const truncate = (s: string, maxLen: number): string => (s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s);

const handleInspect = async (options: { json?: boolean }, projectDir: string = process.cwd()): Promise<void> => {
  // Read dist/tools.json
  const toolsJsonPath = join(projectDir, 'dist', TOOLS_FILENAME);
  if (
    !(await access(toolsJsonPath).then(
      () => true,
      () => false,
    ))
  ) {
    console.error(pc.red('No manifest found. Run opentabs-plugin build first.'));
    process.exit(1);
  }

  let manifest: ToolsJsonManifest;
  try {
    const parsed: unknown = JSON.parse(await readFile(toolsJsonPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    const obj = parsed as Record<string, unknown>;

    if (Array.isArray(obj.tools)) {
      manifest = obj as unknown as ToolsJsonManifest;
    } else {
      throw new Error('unexpected format');
    }
  } catch {
    console.error(
      pc.red(`Failed to parse dist/${TOOLS_FILENAME}. The file may be corrupted — rebuild with opentabs-plugin build.`),
    );
    process.exit(1);
  }

  // --json mode: output raw JSON and exit
  if (options.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // Read package.json for plugin metadata
  let pluginName = '(unknown)';
  let pluginVersion = '(unknown)';
  let displayName: string | undefined;
  const pkgJsonPath = join(projectDir, 'package.json');
  if (
    await access(pkgJsonPath).then(
      () => true,
      () => false,
    )
  ) {
    try {
      const pkgJsonRaw: unknown = JSON.parse(await readFile(pkgJsonPath, 'utf-8'));
      const result = parsePluginPackageJson(pkgJsonRaw, projectDir);
      if (result.ok) {
        pluginName = result.value.name;
        pluginVersion = result.value.version;
        displayName = result.value.opentabs.displayName;
      }
    } catch {
      // Non-fatal — we can still show the manifest
    }
  }

  const tools = manifest.tools;

  // Header
  console.log('');
  console.log(pc.bold(displayName ?? pluginName) + pc.dim(` v${pluginVersion}`));
  if (manifest.sdkVersion) {
    console.log(pc.dim(`SDK version: ${manifest.sdkVersion}`));
  }

  // Summary counts
  console.log(pc.dim(`${tools.length} tool${tools.length === 1 ? '' : 's'}`));
  console.log('');

  // Tools
  if (tools.length > 0) {
    console.log(pc.bold('Tools'));
    console.log('');
    for (const tool of tools) {
      console.log(`  ${pc.cyan(tool.icon)} ${pc.bold(tool.name)}  ${pc.dim(tool.displayName)}`);
      console.log(`    ${truncate(tool.description, 80)}`);

      const inputFields = extractFields(tool.input_schema);
      if (inputFields.length > 0) {
        const fieldStrs = inputFields.map(f => `${f.name}: ${f.type}${f.required ? '' : '?'}`);
        console.log(`    ${pc.dim('Input:')}  ${fieldStrs.join(', ')}`);
      }

      const outputFields = extractFields(tool.output_schema);
      if (outputFields.length > 0) {
        const fieldStrs = outputFields.map(f => `${f.name}: ${f.type}${f.required ? '' : '?'}`);
        console.log(`    ${pc.dim('Output:')} ${fieldStrs.join(', ')}`);
      }
      console.log('');
    }
  }
};

const registerInspectCommand = (program: Command): void => {
  program
    .command('inspect')
    .description('Pretty-print the built plugin manifest (dist/tools.json)')
    .option('--json', 'Output raw JSON instead of formatted summary')
    .addHelpText(
      'after',
      `
Examples:
  $ opentabs-plugin inspect
  $ opentabs-plugin inspect --json`,
    )
    .action((options: { json?: boolean }) => handleInspect(options));
};

export { extractFields, handleInspect, registerInspectCommand, truncate };
export type { ToolsJsonManifest };
