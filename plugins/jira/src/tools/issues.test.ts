import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as jiraApi from '../jira-api.js';
import { getIssue } from './get-issue.js';
import { mapIssue } from './schemas.js';
import { searchIssues } from './search-issues.js';

vi.mock('../jira-api.js', () => ({ api: vi.fn() }));

const api = vi.mocked(jiraApi.api);
const context: ToolHandlerContext = { reportProgress: vi.fn() };

beforeEach(() => {
  api.mockReset();
});

const related = (key: string) => ({ key, fields: { summary: `About ${key}`, status: { name: 'Open' } } });

describe('mapIssue', () => {
  test('reads the related records and dates of an issue', () => {
    const issue = mapIssue({
      id: '1',
      key: 'KAN-1',
      fields: {
        duedate: '2026-11-03',
        resolution: { name: 'Done' },
        resolutiondate: '2026-11-04T10:00:00.000-0400',
        parent: related('KAN-0'),
        subtasks: [related('KAN-2')],
        issuelinks: [
          { type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: related('KAN-3') },
          { type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: related('KAN-4') },
        ],
        attachment: [
          {
            id: '9',
            filename: 'a.png',
            size: 3,
            mimeType: 'image/png',
            created: '2026-10-29T12:00:00.000-0400',
            author: { displayName: 'Pat Doe' },
          },
        ],
        components: [{ name: 'Receiving' }],
        fixVersions: [{ name: 'v1.3' }],
        versions: [{ name: 'v1.2' }],
        timetracking: { originalEstimate: '2d', timeSpent: '1h' },
      },
    });

    expect(issue).toMatchObject({
      due_date: '2026-11-03',
      resolution: 'Done',
      resolved: '2026-11-04T10:00:00.000-0400',
      parent: { key: 'KAN-0', summary: 'About KAN-0', status: 'Open' },
      subtasks: [{ key: 'KAN-2', summary: 'About KAN-2', status: 'Open' }],
      linked_issues: [
        { key: 'KAN-3', relationship: 'blocks' },
        { key: 'KAN-4', relationship: 'is blocked by' },
      ],
      attachments: [
        {
          id: '9',
          filename: 'a.png',
          size: 3,
          mime_type: 'image/png',
          created: '2026-10-29T12:00:00.000-0400',
          author_name: 'Pat Doe',
        },
      ],
      components: ['Receiving'],
      fix_versions: ['v1.3'],
      affected_versions: ['v1.2'],
      time_tracking: { original_estimate: '2d', remaining_estimate: null, time_spent: '1h' },
    });
  });

  test('reports unset fields as null or empty, and custom fields only when selected', () => {
    const issue = mapIssue({ id: '1', key: 'KAN-1', fields: { timetracking: {} } });
    expect(issue).toMatchObject({
      due_date: null,
      resolution: null,
      resolved: null,
      parent: null,
      subtasks: [],
      linked_issues: [],
      attachments: [],
      environment_text: null,
      time_tracking: null,
    });
    expect(issue).not.toHaveProperty('custom_fields');
  });
});

describe('get_issue', () => {
  test('reports the custom fields with a value, leaving out comments and opaque fields', async () => {
    api.mockResolvedValue({
      id: '1',
      key: 'KAN-1',
      fields: { customfield_1: 'INC10164748', customfield_2: '1|ya9nf4:', customfield_3: null },
      names: { customfield_1: 'ServiceNow Number', customfield_2: 'Rank', customfield_3: 'RTM' },
      schema: {
        customfield_1: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' },
        customfield_2: { custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' },
        customfield_3: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' },
      },
    });

    const { issue } = await getIssue.handle({ issue_key: 'KAN-1' }, context);

    expect(issue.custom_fields).toEqual({ 'ServiceNow Number': 'INC10164748' });
    expect(api).toHaveBeenCalledWith('/issue/KAN-1', {
      query: { fields: '*all,-comment,-worklog', expand: 'names,schema' },
    });
  });
});

describe('search_issues', () => {
  /** Answer the search and count requests, and the field list when custom fields are requested. */
  const mockSearch = (search: unknown, count: () => Promise<unknown>) => {
    api.mockImplementation(((endpoint: string) => {
      if (endpoint === '/search/jql') return Promise.resolve(search);
      if (endpoint === '/search/approximate-count') return count();
      if (endpoint === '/field') {
        return Promise.resolve([{ id: 'customfield_1', name: 'ServiceNow Number', custom: true }]);
      }
      return Promise.reject(new Error(`unexpected ${endpoint}`));
    }) as typeof jiraApi.api);
  };

  const searchQuery = () => api.mock.calls.find(([endpoint]) => endpoint === '/search/jql')?.[1]?.query;

  test('returns the next page token and approximate total, and passes a token back', async () => {
    mockSearch({ issues: [{ id: '1', key: 'KAN-1', fields: {} }], nextPageToken: 'page-3' }, () =>
      Promise.resolve({ count: 42 }),
    );

    const result = await searchIssues.handle({ jql: 'project = KAN', next_page_token: 'page-2' }, context);

    expect(result.issues.map(issue => issue.key)).toEqual(['KAN-1']);
    expect(result.approximate_total).toBe(42);
    expect(result.next_page_token).toBe('page-3');
    expect(searchQuery()).toMatchObject({ jql: 'project = KAN', maxResults: 20, nextPageToken: 'page-2' });
  });

  test('reports the last page with a null token', async () => {
    mockSearch({ issues: [] }, () => Promise.resolve({ count: 0 }));
    const result = await searchIssues.handle({ jql: 'project = KAN' }, context);
    expect(result.next_page_token).toBeNull();
    expect(result.approximate_total).toBe(0);
  });

  test('keeps the results when the count fails', async () => {
    mockSearch({ issues: [{ id: '1', key: 'KAN-1', fields: {} }] }, () => Promise.reject(new Error('count failed')));
    const result = await searchIssues.handle({ jql: 'project = KAN' }, context);
    expect(result.issues).toHaveLength(1);
    expect(result.approximate_total).toBeNull();
  });

  test('requests custom fields by id and reports them by name', async () => {
    mockSearch({ issues: [{ id: '1', key: 'KAN-1', fields: { customfield_1: 'INC1' } }] }, () =>
      Promise.resolve({ count: 1 }),
    );

    const result = await searchIssues.handle({ jql: 'project = KAN', custom_fields: ['ServiceNow Number'] }, context);

    expect(result.issues[0]?.custom_fields).toEqual({ 'ServiceNow Number': 'INC1' });
    expect(String(searchQuery()?.fields)).toContain('customfield_1');
  });
});
