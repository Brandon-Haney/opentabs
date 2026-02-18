/**
 * Zod schema for runtime validation of opentabs-plugin.json manifests.
 *
 * Validates the shape and types of plugin manifests read from disk,
 * producing clear error messages for malformed files instead of cryptic
 * downstream crashes from unchecked casts.
 */

import { z } from 'zod';
import type { PluginManifest } from '@opentabs-dev/shared';

const manifestToolSchema = z.object({
  name: z.string().min(1, 'Tool name is required'),
  description: z.string().min(1, 'Tool description is required'),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
});

const pluginManifestSchema = z.looseObject({
  name: z.string().min(1, 'Plugin name is required'),
  version: z.string().min(1, 'Plugin version is required'),
  displayName: z.string().optional(),
  description: z.string().min(1, 'Plugin description is required'),
  url_patterns: z.array(z.string()).min(1, 'At least one URL pattern is required'),
  tools: z.array(manifestToolSchema).min(1, 'At least one tool is required'),
  adapterHash: z.string().optional(),
});

/** Compile-time assertion: schema output must be assignable to PluginManifest */
type _SchemaOutput = z.infer<typeof pluginManifestSchema>;
type _AssertManifestSync = _SchemaOutput extends PluginManifest ? true : never;

/**
 * Parse and validate a plugin manifest JSON string.
 * Throws a descriptive error on invalid input.
 */
export const parseManifest = (raw: string, sourcePath: string): PluginManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in manifest at ${sourcePath}`);
  }

  const result = pluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid plugin manifest at ${sourcePath}:\n${issues}`);
  }

  return result.data;
};
