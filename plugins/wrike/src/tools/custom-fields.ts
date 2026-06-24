import { rpc } from '../wrike-api.js';

// Custom fields are exposed in the work-item-view property model. Each field's
// metadata carries a `typeDefinition` that determines how its value is encoded.
export type CustomFieldType = 'text' | 'single_select' | 'multi_select' | 'date' | 'number';

export interface CustomField {
  id: string;
  name: string;
  type: CustomFieldType;
  /** Allowed values for select fields; empty for free-form fields. */
  options: string[];
  /** Current value rendered as text; empty when unset. */
  value: string;
}

interface TypeDefinition {
  type?: string;
  valueConstraint?: { allowedValues?: string[] | null } | null;
  arrayElementTypeDefinition?: TypeDefinition | null;
}

interface PropertyMeta {
  title?: string;
  origin?: string;
  typeDefinition?: TypeDefinition;
}

interface WivPropertiesResponse {
  propertiesMetadata?: Record<string, PropertyMeta | undefined>;
  propertiesValue?: Record<string, { value?: unknown } | undefined>;
}

const NUMERIC_TYPES = new Set(['Number', 'Numeric', 'Currency', 'Percentage', 'Duration']);

const classify = (def: TypeDefinition | undefined): { type: CustomFieldType; options: string[] } => {
  if (!def) return { type: 'text', options: [] };
  if (def.type === 'Array') {
    const allowed = def.arrayElementTypeDefinition?.valueConstraint?.allowedValues ?? [];
    return { type: 'multi_select', options: allowed ?? [] };
  }
  if (def.type === 'Date' || def.type === 'LocalDateTime') return { type: 'date', options: [] };
  if (def.type && NUMERIC_TYPES.has(def.type)) return { type: 'number', options: [] };
  const allowed = def.valueConstraint?.allowedValues;
  if (Array.isArray(allowed) && allowed.length > 0) return { type: 'single_select', options: allowed };
  return { type: 'text', options: [] };
};

const valueToText = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    return raw
      .map(item =>
        item !== null && typeof item === 'object' && 'value' in item
          ? String((item as { value: unknown }).value)
          : String(item),
      )
      .join(', ');
  }
  return JSON.stringify(raw);
};

/**
 * Reads the custom fields (and their current values) applicable to a work item.
 * Returns only fields the account has defined as custom — system properties like
 * status or assignee are excluded.
 */
export const fetchCustomFields = async (itemId: number): Promise<CustomField[]> => {
  const props = await rpc<WivPropertiesResponse>('wiv_get_properties', {
    entityId: itemId,
    visibilities: ['top', 'visible', 'hidden'],
  });
  const values = props.propertiesValue ?? {};

  const fields: CustomField[] = [];
  for (const [id, meta] of Object.entries(props.propertiesMetadata ?? {})) {
    if (meta?.origin !== 'Custom') continue;
    const { type, options } = classify(meta.typeDefinition);
    fields.push({ id, name: meta.title ?? '', type, options, value: valueToText(values[id]?.value) });
  }
  return fields;
};
