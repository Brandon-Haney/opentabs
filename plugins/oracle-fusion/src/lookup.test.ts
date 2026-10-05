import { describe, expect, test } from 'vitest';
import {
  advancedLookupEvent,
  closeLookupEvent,
  lookupPanelId,
  lookupTableId,
  lookupViewportDeltas,
  openLookupEvents,
} from './lookup.js';

const FIELD = 'r:app:rcvQry:value00';

describe('lookup dialog events', () => {
  test('names the dialog’s panel and table after the field', () => {
    expect(lookupPanelId(FIELD)).toBe(`${FIELD}::_afrLovInternalQueryId`);
    expect(lookupTableId(FIELD)).toBe(`${FIELD}_afrLovInternalTableId`);
    expect(lookupViewportDeltas(FIELD)).toBe(`{${FIELD}_afrLovInternalTableId={viewportSize=10000}}`);
  });

  test('opens the dialog with the field’s search command, then its popup', () => {
    const [search, launch] = openLookupEvents(FIELD, { a: '1' });
    expect(search).toMatchObject({ source: FIELD, fields: { a: '1' }, deltas: `{${FIELD}lovPopupId={_shown=}}` });
    expect(search?.payload).toContain('<k v="action"><s>click</s></k><k v="type"><s>lovInternal</s></k>');
    expect(launch?.payload).toContain('<s>launchPopup</s>');
  });

  test('switches the dialog to its advanced mode', () => {
    const event = advancedLookupEvent(FIELD, {});
    expect(event.source).toBe(`${FIELD}::_afrLovInternalQueryId`);
    expect(event.payload).toContain('<k v="operation"><s>MODE_CHANGE</s></k><k v="type"><s>queryOperation</s></k>');
  });

  test('closes the dialog without choosing a value', () => {
    const event = closeLookupEvent(FIELD, {});
    expect(event.source).toBe(FIELD);
    expect(event.payload).toContain('<k v="operation"><s>CANCEL</s></k><k v="type"><s>lovInternalpopupclosed</s></k>');
  });
});
