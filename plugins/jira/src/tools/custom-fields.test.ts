import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as jiraApi from '../jira-api.js';
import {
  customFieldNamesFromExpand,
  flattenFieldValue,
  mapCustomFields,
  resolveCustomFields,
} from './custom-fields.js';

vi.mock('../jira-api.js', () => ({ api: vi.fn() }));

const api = vi.mocked(jiraApi.api);

beforeEach(() => {
  api.mockReset();
});

describe('flattenFieldValue', () => {
  test('keeps primitives, including zero and false', () => {
    expect(flattenFieldValue('INC10164748')).toBe('INC10164748');
    expect(flattenFieldValue(5)).toBe(5);
    expect(flattenFieldValue(0)).toBe(0);
    expect(flattenFieldValue(false)).toBe(false);
  });

  test('treats null, empty text, empty lists and empty rich text as no value', () => {
    expect(flattenFieldValue(null)).toBeUndefined();
    expect(flattenFieldValue('')).toBeUndefined();
    expect(flattenFieldValue([])).toBeUndefined();
    expect(flattenFieldValue([null])).toBeUndefined();
    expect(flattenFieldValue({ type: 'doc', version: 1, content: [] })).toBeUndefined();
  });

  test('flattens the shapes Jira uses for option, user, cascading and version fields', () => {
    expect(flattenFieldValue({ self: 'x', value: 'Staging', id: '1' })).toBe('Staging');
    expect(flattenFieldValue([{ value: 'No', id: '1' }])).toEqual(['No']);
    expect(flattenFieldValue({ value: 'Parent', child: { value: 'Child' } })).toBe('Parent > Child');
    expect(flattenFieldValue({ accountId: 'a', displayName: 'Pat Doe' })).toBe('Pat Doe');
    expect(flattenFieldValue({ name: 'v1.3' })).toBe('v1.3');
  });

  test('reads a sprint with its state', () => {
    expect(flattenFieldValue([{ id: 1, name: 'Sprint 43', state: 'active', boardId: 2 }])).toEqual([
      'Sprint 43 (active)',
    ]);
  });

  test('reads rich text as markdown', () => {
    const doc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] };
    expect(flattenFieldValue(doc)).toBe('Hi');
  });

  test('keeps a shape with no rule as JSON, marking it when cut short', () => {
    expect(flattenFieldValue({ self: 'x', hours: 3 })).toBe('{"hours":3}');
    const long = flattenFieldValue({ text: 'y'.repeat(600) }) as string;
    expect(long.endsWith('… [truncated]')).toBe(true);
  });
});

describe('mapCustomFields', () => {
  test('reports fields with a value under their names', () => {
    const names = new Map([
      ['customfield_1', 'Story Points'],
      ['customfield_2', 'RTM'],
    ]);
    expect(mapCustomFields({ customfield_1: 5, customfield_2: null }, names)).toEqual({ 'Story Points': 5 });
  });

  test('labels a second field of the same name with its id', () => {
    const names = new Map([
      ['customfield_1', 'Business Unit'],
      ['customfield_2', 'Business Unit'],
    ]);
    expect(mapCustomFields({ customfield_1: 'A', customfield_2: 'B' }, names)).toEqual({
      'Business Unit': 'A',
      'Business Unit (customfield_2)': 'B',
    });
  });
});

describe('customFieldNamesFromExpand', () => {
  test('keeps custom fields and leaves out system and opaque ones', () => {
    const names = customFieldNamesFromExpand(
      { summary: 'Summary', customfield_1: 'RTM', customfield_2: 'Rank', customfield_3: 'Development' },
      {
        customfield_1: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' },
        customfield_2: { custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' },
        customfield_3: { custom: 'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf' },
      },
    );
    expect([...names]).toEqual([['customfield_1', 'RTM']]);
  });
});

describe('resolveCustomFields', () => {
  const FIELDS = [
    { id: 'summary', name: 'Summary', custom: false },
    { id: 'customfield_1', name: 'ServiceNow Number', custom: true },
    { id: 'customfield_2', name: 'Business Unit', custom: true },
    { id: 'customfield_3', name: 'Business Unit', custom: true },
  ];

  test('makes no request when nothing is asked for', async () => {
    await expect(resolveCustomFields([])).resolves.toEqual(new Map());
    expect(api).not.toHaveBeenCalled();
  });

  test('matches names in any case, ids, and every field sharing a name', async () => {
    api.mockResolvedValue(FIELDS);
    const resolved = await resolveCustomFields(['servicenow number', 'customfield_2', 'Business Unit']);
    expect([...resolved.keys()]).toEqual(['customfield_1', 'customfield_2', 'customfield_3']);
    expect(resolved.get('customfield_1')).toBe('ServiceNow Number');
  });

  test('rejects an unknown name, suggesting similar ones', async () => {
    api.mockResolvedValue(FIELDS);
    await expect(resolveCustomFields(['ServiceNow'])).rejects.toThrow(
      'No custom field is named "ServiceNow". Similar fields: "ServiceNow Number".',
    );
  });
});
