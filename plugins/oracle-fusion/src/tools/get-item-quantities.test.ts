import { describe, expect, test } from 'vitest';
import { SearchRejectedError } from '../search-screen.js';
import { nothingFoundMessage, unknownValueMessage } from './get-item-quantities.js';

describe('nothingFoundMessage', () => {
  test('says an item may have nothing there and asks to check the item number', () => {
    expect(nothingFoundMessage({ organization: 'GA0081', item: '4115-NGK' })).toBe(
      'Oracle Fusion shows no quantities for item 4115-NGK in GA0081. The item may have nothing on hand, ' +
        'receiving or inbound there; check that the item number is entered correctly.',
    );
  });

  test('names the description, subinventory and locator searched', () => {
    expect(
      nothingFoundMessage({
        organization: 'GA0081',
        item_description: 'Rotor',
        subinventory: 'BACKSTOCK',
        locator: '123.02.00',
      }),
    ).toBe(
      'Oracle Fusion shows no quantities for items whose description starts with "Rotor" in GA0081, ' +
        'subinventory BACKSTOCK, locator 123.02.00. Nothing may be stored there; check that the search values ' +
        'are entered correctly.',
    );
    expect(nothingFoundMessage({ organization: 'GA0081', locator: 'E02.02' })).toMatch(
      /^Oracle Fusion shows no quantities for any item in GA0081, locator E02\.02\./,
    );
  });
});

describe('unknownValueMessage', () => {
  const refusal = (...messages: { field: string; text: string }[]) =>
    new SearchRejectedError(messages.map(message => ({ severity: 'error' as const, ...message })));

  test('says which value Fusion does not know', () => {
    expect(
      unknownValueMessage(refusal({ field: 'Item', text: 'Invalid value: 4115-NGKX.' }), {
        organization: 'GA0081',
        item: '4115-NGKX',
      }),
    ).toBe('Oracle Fusion has no item 4115-NGKX in GA0081. Check that it is entered correctly.');
    expect(
      unknownValueMessage(refusal({ field: 'Organization', text: 'Invalid value: GA9999.' }), {
        organization: 'GA9999',
      }),
    ).toBe('Oracle Fusion has no organization GA9999. Check that it is entered correctly.');
  });

  test('leaves any other refusal as it is', () => {
    const search = { organization: 'GA0081', item: '4115-NGK' };
    expect(unknownValueMessage(refusal({ field: '', text: 'Too many matching records found.' }), search)).toBeNull();
    expect(
      unknownValueMessage(
        refusal({ field: 'Item', text: 'Invalid value: X.' }, { field: 'Receiving', text: 'Not allowed.' }),
        search,
      ),
    ).toBeNull();
  });
});
