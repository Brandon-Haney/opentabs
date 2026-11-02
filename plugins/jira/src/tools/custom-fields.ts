import { ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../jira-api.js';
import { adfToMarkdown } from './adf.js';

/**
 * Custom fields, reported by display name with their values flattened to something
 * readable. Jira returns each field type in its own shape (an option object, a user,
 * a sprint, rich text), and a shape with no flattening rule is kept as JSON so its
 * content stays visible.
 */

const primitiveValue = z.union([z.string(), z.number(), z.boolean()]);

export const customFieldsSchema = z
  .record(z.string(), z.union([primitiveValue, z.array(primitiveValue)]))
  .describe('Custom field values by field name. Only fields with a value appear.');

type Primitive = z.infer<typeof primitiveValue>;
type FieldValue = Primitive | Primitive[];

/** Longest JSON kept for a value of a shape with no flattening rule. */
const MAX_JSON_LENGTH = 500;

/** Field types whose values are internal bookkeeping with no meaning to a reader. */
const OPAQUE_FIELD_TYPES = ['gh-lexo-rank', 'devsummarycf'];

const isOpaqueFieldType = (customType: string | undefined): boolean =>
  OPAQUE_FIELD_TYPES.some(type => customType?.endsWith(`:${type}`));

const flattenObject = (value: Record<string, unknown>): Primitive => {
  if (value.type === 'doc') return adfToMarkdown(value);
  if (typeof value.value === 'string') {
    const child = value.child as { value?: unknown } | undefined;
    return typeof child?.value === 'string' ? `${value.value} > ${child.value}` : value.value;
  }
  if (typeof value.displayName === 'string') return value.displayName;
  if (typeof value.name === 'string') {
    return typeof value.state === 'string' ? `${value.name} (${value.state})` : value.name;
  }
  if (typeof value.key === 'string') return value.key;
  const { self: _self, ...rest } = value;
  const json = JSON.stringify(rest);
  return json.length > MAX_JSON_LENGTH ? `${json.slice(0, MAX_JSON_LENGTH)}… [truncated]` : json;
};

/** Keys of the error Jira puts in place of a value it cannot compute, such as an SLA outside a service project. */
const ERROR_KEYS = new Set(['errorMessage', 'i18nErrorMessage']);

/** A value that holds only Jira's error, which says the field has nothing to show. */
const isErrorOnly = (value: Record<string, unknown>): boolean =>
  typeof value.errorMessage === 'string' && Object.keys(value).every(key => ERROR_KEYS.has(key));

const flattenItem = (value: unknown): Primitive | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  const object = value as Record<string, unknown>;
  if (isErrorOnly(object)) return undefined;
  return flattenObject(object) || undefined;
};

/** Flatten one field's value, or undefined when the field is empty. */
export const flattenFieldValue = (value: unknown): FieldValue | undefined => {
  if (!Array.isArray(value)) return flattenItem(value);
  const items = value.map(flattenItem).filter(item => item !== undefined);
  return items.length > 0 ? items : undefined;
};

/**
 * Report the issue's custom fields that have a value, under the names given in `names`
 * (field id → display name). Fields missing from `names` are left out. Jira allows
 * several custom fields to share a name, so a later one with a value is labelled with
 * its id as well.
 */
export const mapCustomFields = (
  fields: Record<string, unknown>,
  names: Map<string, string>,
): Record<string, FieldValue> => {
  const mapped: Record<string, FieldValue> = {};
  for (const [id, name] of names) {
    const value = flattenFieldValue(fields[id]);
    if (value === undefined) continue;
    mapped[name in mapped ? `${name} (${id})` : name] = value;
  }
  return mapped;
};

/** The display names of an issue's custom fields, from `expand=names,schema`, leaving out opaque ones. */
export const customFieldNamesFromExpand = (
  names: Record<string, string> | undefined,
  schema: Record<string, { custom?: string }> | undefined,
): Map<string, string> => {
  const result = new Map<string, string>();
  for (const [id, name] of Object.entries(names ?? {})) {
    if (id.startsWith('customfield_') && !isOpaqueFieldType(schema?.[id]?.custom)) result.set(id, name);
  }
  return result;
};

interface JiraField {
  id?: string;
  name?: string;
  custom?: boolean;
}

const MAX_SUGGESTIONS = 5;

/**
 * Resolve requested custom fields, given by name (any case) or id, to field id → display
 * name. One name can match several fields, and all of them are included. A request that
 * matches nothing is an error, so a mistyped name is not read as an empty field.
 */
export const resolveCustomFields = async (requested: string[]): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  if (requested.length === 0) return resolved;
  const customFields = (await api<JiraField[]>('/field')).filter(field => field.custom && field.id && field.name);
  for (const request of requested) {
    const wanted = request.trim().toLowerCase();
    const matches = customFields.filter(field => field.id === request.trim() || field.name?.toLowerCase() === wanted);
    if (matches.length === 0) {
      const similar = customFields
        .filter(field => field.name?.toLowerCase().includes(wanted))
        .slice(0, MAX_SUGGESTIONS)
        .map(field => `"${field.name}"`);
      throw ToolError.validation(
        `No custom field is named "${request}".${similar.length > 0 ? ` Similar fields: ${similar.join(', ')}.` : ''}`,
      );
    }
    for (const field of matches) resolved.set(field.id ?? '', field.name ?? '');
  }
  return resolved;
};
