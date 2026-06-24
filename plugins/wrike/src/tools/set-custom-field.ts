import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editTaskProperty } from '../wrike-api.js';
import { fetchCustomFields } from './custom-fields.js';

export const setCustomField = defineTool({
  name: 'set_custom_field',
  displayName: 'Set Custom Field',
  description:
    'Set the value of an EXISTING custom field on a task, project, or folder. Identify the field by its name (e.g. "Tracking Status") or id — call list_custom_fields first to see field names, types, and valid options. This only fills in a value on a field that already exists; it never creates a new custom field. For single-select fields the value must match one of the field options exactly; for date fields use YYYY-MM-DD. Multi-select fields are not yet supported.',
  summary: 'Set a value on an existing custom field',
  icon: 'tag',
  group: 'Tasks',
  input: z.object({
    item_id: z.string().describe('The task, project, or folder id'),
    field: z.string().describe('The custom field name (e.g. "Tracking Status") or its id'),
    value: z
      .string()
      .describe(
        'The value to set. For single-select fields it must match one of the options; for dates use YYYY-MM-DD.',
      ),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the field was set'),
    field: z.string().describe('The resolved field name'),
    value: z.string().describe('The value that was set'),
  }),
  handle: async params => {
    const itemId = Number(params.item_id);
    const fields = await fetchCustomFields(itemId);

    const needle = params.field.trim().toLowerCase();
    const field = fields.find(candidate => candidate.id === params.field || candidate.name.toLowerCase() === needle);
    if (!field) {
      const available = fields
        .map(candidate => candidate.name)
        .filter(Boolean)
        .join(', ');
      throw ToolError.notFound(
        `No custom field "${params.field}" on this item. Available fields: ${available || '(none)'}.`,
      );
    }

    if (field.type === 'multi_select') {
      throw ToolError.validation(
        `"${field.name}" is a multi-select field, which set_custom_field does not support yet.`,
      );
    }
    if (field.type === 'single_select' && !field.options.includes(params.value)) {
      throw ToolError.validation(
        `"${params.value}" is not a valid value for "${field.name}". Options: ${field.options.join(', ')}.`,
      );
    }

    const value: unknown =
      field.type === 'number' && params.value !== '' && !Number.isNaN(Number(params.value))
        ? Number(params.value)
        : params.value;

    await editTaskProperty(itemId, { [field.id]: { type: 'SetValue', value } }, [field.id]);
    return { success: true, field: field.name, value: params.value };
  },
});
