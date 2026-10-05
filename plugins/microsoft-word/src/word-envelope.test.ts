import { describe, expect, test } from 'vitest';
import { completeWordEnvelope, WORD_ENVELOPE_FLAG } from './word-envelope.js';

/** The editor's latest poll entry, as the pre-script keeps it. */
const poll = {
  OperationId: 1,
  DependentOn: 0,
  LocalCobaltSessionId: 'session',
  LocalCobaltMachineId: 'machine',
  LocalCobaltClusterId: 'cluster',
  LocalCobaltSessionHasBackup: true,
  WaciiEnabledRequests: 28344448,
  SettingsRoutedToServer: 0,
  LineageId: 'lineage',
  FileId: 'WOPIsrc=x&access_token=secret',
  RevisionRequest: { CellId: 'cell|1' },
  IsUserAlone: true,
  ExpectedLatestRevisionId: 'head|7',
};

const entryOf = (body: string): Record<string, unknown> =>
  (JSON.parse(body) as { srs: [number, Record<string, unknown>][] }).srs[0]?.[1] as Record<string, unknown>;

describe('completeWordEnvelope', () => {
  test('leaves an unflagged request untouched', () => {
    const body = JSON.stringify({ Mode: 2, srs: [[2, { ExpectedLatestRevisionId: 'x' }]] });
    expect(completeWordEnvelope(body, poll)).toBe(body);
  });

  test('completes a flagged read from the poll, keeping what the caller set', () => {
    const body = JSON.stringify({
      Mode: 2,
      srs: [[2, { [WORD_ENVELOPE_FLAG]: true, ExpectedLatestRevisionId: 'zero|0' }]],
    });
    const entry = entryOf(completeWordEnvelope(body, poll));
    expect(entry).toEqual({ ...poll, ExpectedLatestRevisionId: 'zero|0' });
  });

  test('gives a flagged write the session identifiers and its revision the file id', () => {
    const body = JSON.stringify({
      Mode: 2,
      srs: [
        [
          3,
          {
            OperationId: 1,
            DependentOn: 0,
            [WORD_ENVELOPE_FLAG]: true,
            Revision: { Id: 'g|1', BaseId: 'head|7' },
            ExpectedLatestId: 'head|7',
          },
        ],
      ],
    });
    const entry = entryOf(completeWordEnvelope(body, poll));
    expect(entry[WORD_ENVELOPE_FLAG]).toBeUndefined();
    expect(entry.LocalCobaltSessionId).toBe('session');
    expect(entry.LineageId).toBe('lineage');
    expect(entry.Revision).toEqual({ Id: 'g|1', BaseId: 'head|7', FileId: poll.FileId });
    expect(entry.ExpectedLatestId).toBe('head|7');
    // A write carries only what it names; the poll's read fields stay out of it.
    expect(entry.RevisionRequest).toBeUndefined();
    expect(entry.FileId).toBeUndefined();
  });

  test('refuses to send a flagged request before the editor has polled', () => {
    const body = JSON.stringify({ Mode: 2, srs: [[2, { [WORD_ENVELOPE_FLAG]: true }]] });
    expect(() => completeWordEnvelope(body, null)).toThrow(/has not polled/);
  });
});
