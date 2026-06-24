import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { editTaskProperty } from '../wrike-api.js';
import { type CustomField, fetchCustomFields } from './custom-fields.js';

// Multi-select values are stored as a list; the tool accepts a comma-separated
// string and sets the field to exactly that list.
const parseList = (value: string): string[] =>
  value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

const setMultiSelect = async (itemId: number, field: CustomField, value: string): Promise<string> => {
  const desired = parseList(value);
  const invalid = desired.filter(entry => !field.options.includes(entry));
  if (invalid.length > 0) {
    throw ToolError.validation(
      `Invalid value(s) for "${field.name}": ${invalid.join(', ')}. Options: ${field.options.join(', ')}.`,
    );
  }

  const current = parseList(field.value);
  const valuesAdd = desired.filter(entry => !current.includes(entry));
  const valuesRemove = current.filter(entry => !desired.includes(entry));
  if (valuesAdd.length > 0 || valuesRemove.length > 0) {
    await editTaskProperty(itemId, { [field.id]: { type: 'UpdateCollection', valuesAdd, valuesRemove } }, [field.id]);
  }
  return desired.join(', ');
};

const setSingleValue = async (itemId: number, field: CustomField, value: string): Promise<string> => {
  if (field.type === 'single_select' && !field.options.includes(value)) {
    throw ToolError.validation(
      `"${value}" is not a valid value for "${field.name}". Options: ${field.options.join(', ')}.`,
    );
  }
  const encoded: unknown =
    field.type === 'number' && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
  await editTaskProperty(itemId, { [field.id]: { type: 'SetValue', value: encoded } }, [field.id]);
  return value;
};

export const setCustomField = defineTool({
  name: 'set_custom_field',
  displayName: 'Set Custom Field',
  description:
    'Set the value of an EXISTING custom field on a task, project, or folder. Identify the field by its name (e.g. "Tracking Status") or id — call list_custom_fields first to see field names, types, and valid options. This only fills in a value on a field that already exists; it never creates a new custom field. For single-select fields the value must match one of the options; for multi-select fields pass a comma-separated list of options and the field is set to exactly that list (pass an empty string to clear it); for date fields use YYYY-MM-DD.',
  summary: 'Set a value on an existing custom field',
  icon: 'tag',
  group: 'Tasks',
  input: z.object({
    item_id: z.string().describe('The task, project, or folder id'),
    field: z.string().describe('The custom field name (e.g. "Tracking Status") or its id'),
    value: z
      .string()
      .describe(
        'The value to set. Single-select: one of the options. Multi-select: a comma-separated list of options. Date: YYYY-MM-DD. Pass an empty string to clear the field.',
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

    const value =
      field.type === 'multi_select'
        ? await setMultiSelect(itemId, field, params.value)
        : await setSingleValue(itemId, field, params.value);

    return { success: true, field: field.name, value };
  },
});
