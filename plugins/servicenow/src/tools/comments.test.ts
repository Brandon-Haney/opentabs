import { ToolError } from '@opentabs-dev/plugin-sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { tableUpdate } from '../servicenow-api.js';
import { addComment } from './add-comment.js';
import { previewComment } from './preview-comment.js';

const SYS_ID = '2a6c4d533b6926905722bd8c24e45a7e';
const ME = 'Sam Rivera';

interface Patch {
  url: string;
  token: string;
  contentType: string;
  body: Record<string, string>;
}

/** A fake instance, so these tests run the real request code without a real ticket. */
const instance = {
  active: 'true',
  journal: { comments: '', work_notes: '' } as Record<string, string>,
  sequence: 0,
  patches: [] as Patch[],
  methods: [] as string[],
  /** Replaces the instance's answer to a PATCH; returning undefined applies the write normally. */
  onPatch: (() => undefined) as (token: string) => Response | undefined,
  /** Fails reads of the record once the write has landed, as an expired session would. */
  readBackResponse: undefined as Response | undefined,
  formField: { sys_readonly: false } as Record<string, unknown> | undefined,
  formStatus: 200,
};

const json = (result: unknown, init?: ResponseInit) => new Response(JSON.stringify({ result }), init);

const field = (value: string, display = value) => ({ value, display_value: display });

const appendEntry = (name: string, body: string, author = ME) => {
  instance.sequence += 1;
  const kind = name === 'comments' ? 'Additional comments' : 'Work notes';
  const stamp = `2026-10-30 09:00:${String(instance.sequence).padStart(2, '0')}`;
  instance.journal[name] = `${stamp} - ${author} (${kind})\n${body}\n\n${instance.journal[name] ?? ''}`;
};

const recordFields = () => ({
  number: field('INC0010023'),
  sys_id: field(SYS_ID),
  short_description: field('Printer offline'),
  state: field('2', 'In Progress'),
  priority: field('3', '3 - Moderate'),
  opened_at: field('2026-10-29 08:00:00'),
  sys_updated_on: field('2026-10-30 08:00:00'),
  assigned_to: field('', ''),
  assignment_group: field('g1', 'Store Support'),
  active: field(instance.active),
  caller_id: field('u1', 'Alex Kim'),
  opened_by: field('u2', 'Pat Lee'),
  watch_list: field('', ''),
  work_notes_list: field('', ''),
  comments: field(instance.journal.comments ?? ''),
  work_notes: field(instance.journal.work_notes ?? ''),
});

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const headers = init?.headers as Record<string, string>;
  const token = headers['X-UserToken'] ?? '';
  instance.methods.push(method);

  if (method === 'PATCH') {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    instance.patches.push({ url, token, contentType: headers['Content-Type'] ?? '', body });
    const override = instance.onPatch(token);
    if (override) return override;
    for (const [name, entry] of Object.entries(body)) appendEntry(name, entry);
    return json({ sys_id: SYS_ID });
  }

  if (url.startsWith('/api/now/ui/user/current_user')) return json({ user_display_name: ME });
  if (url.startsWith('/api/now/ui/meta/')) return json({ columns: { comments: { label: 'User Communication' } } });
  if (url.startsWith('/api/now/sp/page')) {
    const widgets = [{ widget: { data: { f: { _fields: { comments: instance.formField } } } } }];
    return json({ containers: [{ rows: [{ columns: [{ widgets }] }] }] }, { status: instance.formStatus });
  }
  if (url.startsWith('/api/now/table/task')) {
    return url.includes('MISSING')
      ? json([])
      : json([{ sys_id: field(SYS_ID), sys_class_name: field('incident', 'Incident') }]);
  }
  if (url.startsWith('/api/now/table/incident')) {
    if (instance.patches.length > 0 && instance.readBackResponse) return instance.readBackResponse;
    return json([recordFields()]);
  }
  throw new Error(`Unexpected request: ${method} ${url}`);
};

const post = (text: string, name: 'comments' | 'work_notes' = 'comments') =>
  addComment.handle({ record: 'INC0010023', field: name, text });

beforeEach(() => {
  Object.assign(instance, {
    active: 'true',
    journal: { comments: '', work_notes: '' },
    sequence: 0,
    patches: [],
    methods: [],
    onPatch: () => undefined,
    readBackResponse: undefined,
    formField: { sys_readonly: false },
    formStatus: 200,
  });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  const page = globalThis as unknown as { g_ck?: string; __openTabs?: unknown };
  page.g_ck = 'token-1';
  page.__openTabs = undefined;
});

describe('add_comment', () => {
  test('sends one PATCH to the concrete table and reports the entry it finds', async () => {
    const result = await post('Replacement is on the way.');

    expect(instance.patches).toEqual([
      {
        url: `/api/now/table/incident/${SYS_ID}?sysparm_fields=sys_id`,
        token: 'token-1',
        contentType: 'application/json',
        body: { comments: 'Replacement is on the way.' },
      },
    ]);
    expect(result).toMatchObject({
      number: 'INC0010023',
      table: 'incident',
      status: 'posted',
      entry: { author: ME, kind: 'Additional comments', text: 'Replacement is on the way.' },
    });
  });

  test('keeps a work note out of the customer-visible field', async () => {
    const result = await post('Checked the spooler.', 'work_notes');

    expect(instance.patches[0]?.body).toEqual({ work_notes: 'Checked the spooler.' });
    expect(result.entry?.kind).toBe('Work notes');
  });

  test('reports not_in_journal when the instance answers 200 but skipped the field', async () => {
    instance.onPatch = () => json({ sys_id: SYS_ID });

    const result = await post('Replacement is on the way.');

    expect(result).toMatchObject({ status: 'not_in_journal', entry: null });
    expect(instance.patches).toHaveLength(1);
  });

  test("does not take another person's concurrent entry as confirmation", async () => {
    instance.onPatch = () => {
      appendEntry('comments', 'Unrelated update', 'Alex Kim');
      return json({ sys_id: SYS_ID });
    };

    expect(await post('Replacement is on the way.')).toMatchObject({ status: 'not_in_journal', entry: null });
  });

  test('confirms by author when the instance reformats the text on save', async () => {
    instance.onPatch = () => {
      appendEntry('comments', 'Reformatted by the instance');
      return json({ sys_id: SYS_ID });
    };

    expect(await post('Replacement is on the way.')).toMatchObject({ status: 'posted' });
  });

  test('resolves after a successful write even when the read-back loses the session', async () => {
    instance.readBackResponse = new Response('expired', { status: 401 });

    // A rejection here would be an auth error, which session recovery answers by running the tool again.
    expect(await post('Replacement is on the way.')).toMatchObject({ status: 'unverified', entry: null });
    expect(instance.patches).toHaveLength(1);
  });

  test('retries once with the replacement token after a rotated-token 401', async () => {
    instance.onPatch = token =>
      token === 'token-1'
        ? new Response('rotated', { status: 401, headers: { 'X-UserToken-Response': 'token-2' } })
        : undefined;

    const result = await post('Replacement is on the way.');

    expect(instance.patches.map(patch => patch.token)).toEqual(['token-1', 'token-2']);
    expect(result).toMatchObject({ status: 'posted' });
  });

  test('reports an access refusal without marking it as an auth failure', async () => {
    instance.onPatch = () => new Response('ACL Exception', { status: 403 });

    const error = await post('Replacement is on the way.').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 'WRITE_DENIED', retryable: false });
    expect((error as ToolError).category).not.toBe('auth');
    expect(instance.patches).toHaveLength(1);
  });

  test.each([
    ['a server error', () => new Response('boom', { status: 503 })],
    [
      'a timeout',
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ],
    [
      'a network failure',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('treats %s as an unknown outcome that must not be retried', async (_name, failure) => {
    instance.onPatch = failure;

    await expect(post('Replacement is on the way.')).rejects.toMatchObject({
      code: 'WRITE_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(instance.patches).toHaveLength(1);
  });

  test('refuses text the same user already posted, without writing', async () => {
    appendEntry('comments', 'Replacement is on the way.');

    await expect(post('  Replacement is on  the way. ')).rejects.toMatchObject({ code: 'DUPLICATE_COMMENT' });
    expect(instance.patches).toHaveLength(0);
  });

  test('allows text another person already posted', async () => {
    appendEntry('comments', 'Any update?', 'Alex Kim');

    expect(await post('Any update?')).toMatchObject({ status: 'posted', entry: { author: ME } });
  });

  test('a second call for the same text cannot post twice', async () => {
    await post('Replacement is on the way.');

    await expect(post('Replacement is on the way.')).rejects.toMatchObject({ code: 'DUPLICATE_COMMENT' });
    expect(instance.patches).toHaveLength(1);
  });

  test('rejects whitespace-only text, without writing', async () => {
    await expect(post('   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(instance.patches).toHaveLength(0);
  });

  test('raises not-found for an unknown record, without writing', async () => {
    await expect(addComment.handle({ record: 'MISSING', field: 'comments', text: 'Hello' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(instance.patches).toHaveLength(0);
  });
});

describe('preview_comment', () => {
  const preview = (text = 'Replacement is on the way.') =>
    previewComment.handle({ record: 'INC0010023', field: 'comments', text });

  test('issues only GET requests', async () => {
    await preview();

    expect(instance.methods.length).toBeGreaterThan(0);
    expect(new Set(instance.methods)).toEqual(new Set(['GET']));
  });

  test('reports the exact request add_comment then sends', async () => {
    const { request } = await preview();

    await post('Replacement is on the way.');

    const sent = instance.patches[0];
    expect(request).toEqual({ method: 'PATCH', path: sent?.url, body: JSON.stringify(sent?.body) });
  });

  test('describes the record, its requester and the label this instance gives the field', async () => {
    appendEntry('comments', 'Any update?', 'Alex Kim');

    expect(await preview()).toMatchObject({
      record: {
        number: 'INC0010023',
        table: 'incident',
        table_label: 'Incident',
        short_description: 'Printer offline',
      },
      requester: { name: 'Alex Kim', sys_id: 'u1' },
      field_label: 'User Communication',
      access: 'writable',
      already_posted: false,
      warnings: [],
      recent_entries: [{ author: 'Alex Kim', text: 'Any update?' }],
    });
  });

  test('cuts long entries down in recent_entries, keeping only the newest three', async () => {
    for (const body of ['one', 'two', 'three']) appendEntry('comments', body, 'Alex Kim');
    appendEntry('comments', 'x'.repeat(2000), 'Alex Kim');

    const { recent_entries: recent } = await preview();

    expect(recent).toHaveLength(3);
    expect(recent[0]?.text).toBe(`${'x'.repeat(500)}…`);
    expect(recent[1]?.text).toBe('three');
  });

  test('warns when the instance reports the field read-only for this user', async () => {
    instance.formField = { sys_readonly: true };

    const result = await preview();

    expect(result.access).toBe('read_only');
    expect(result.warnings.join(' ')).toContain('may not write');
  });

  test.each([
    ['the form leaves the field out', () => (instance.formField = undefined)],
    ['the portal page fails', () => (instance.formStatus = 500)],
  ])('reports access as unknown when %s', async (_name, arrange) => {
    arrange();

    expect((await preview()).access).toBe('unknown');
  });

  test('warns about a closed record and about text already posted', async () => {
    instance.active = 'false';
    appendEntry('comments', 'Replacement is on the way.');

    const result = await preview();

    expect(result.already_posted).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });
});

describe('tableUpdate', () => {
  test('fails as a sign-in error, sending nothing, when the tab has no session', async () => {
    (globalThis as unknown as { g_ck?: string }).g_ck = undefined;

    const error = await tableUpdate('incident', SYS_ID, { comments: 'Hello' }).catch((e: unknown) => e);

    // Session recovery answers an auth error by signing in and running the tool again, which is
    // safe only because nothing reached the instance.
    expect(error).toMatchObject({ category: 'auth' });
    expect(error).not.toMatchObject({ code: 'WRITE_OUTCOME_UNKNOWN' });
    expect(instance.methods).toHaveLength(0);
  });
});
