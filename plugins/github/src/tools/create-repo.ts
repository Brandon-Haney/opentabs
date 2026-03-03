import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../github-api.js';
import { mapRepository, repositorySchema } from './schemas.js';

export const createRepo = defineTool({
  name: 'create_repo',
  displayName: 'Create Repository',
  description: 'Create a new repository for the authenticated user.',
  icon: 'plus-circle',
  input: z.object({
    name: z.string().min(1).describe('Repository name'),
    description: z.string().optional().describe('Short description of the repository'),
    private: z.boolean().optional().describe('Whether the repository is private (default: false)'),
    auto_init: z.boolean().optional().describe('Initialize with a README (default: false)'),
    gitignore_template: z.string().optional().describe('Gitignore template name (e.g., "Node", "Python")'),
    license_template: z.string().optional().describe('License template (e.g., "mit", "apache-2.0")'),
  }),
  output: z.object({
    repository: repositorySchema.describe('The created repository'),
  }),
  handle: async params => {
    const body: Record<string, unknown> = { name: params.name };
    if (params.description !== undefined) body.description = params.description;
    if (params.private !== undefined) body.private = params.private;
    if (params.auto_init !== undefined) body.auto_init = params.auto_init;
    if (params.gitignore_template !== undefined) body.gitignore_template = params.gitignore_template;
    if (params.license_template !== undefined) body.license_template = params.license_template;

    const data = await api<Record<string, unknown>>('/user/repos', {
      method: 'POST',
      body,
    });
    return { repository: mapRepository(data) };
  },
});
