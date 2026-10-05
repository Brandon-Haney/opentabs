import { describe, expect, test } from 'vitest';
import { SearchRejectedError } from '../search-screen.js';
import { unknownDocuments } from './search-expected-shipments.js';

const refusal = (...messages: { field: string; text: string }[]) =>
  new SearchRejectedError(messages.map(message => ({ severity: 'error' as const, ...message })));

describe('unknownDocuments', () => {
  test('names the document fields Fusion refused as an invalid value', () => {
    const error = refusal({ field: 'RMA', text: 'Invalid value: ATL001-100002.' });
    expect(unknownDocuments(error, ['rma', 'purchase_order'])).toEqual(new Set(['rma']));
  });

  test('treats any other refusal as an error, not a missing document', () => {
    expect(unknownDocuments(refusal({ field: 'Item', text: 'Invalid value: X-1.' }), ['rma'])).toBeNull();
    expect(unknownDocuments(refusal({ field: 'RMA', text: 'Too many matching records found.' }), ['rma'])).toBeNull();
    expect(
      unknownDocuments(
        refusal({ field: 'RMA', text: 'Invalid value: 1.' }, { field: '', text: 'An unexpected error.' }),
        ['rma'],
      ),
    ).toBeNull();
  });
});
