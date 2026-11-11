import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import type { AdfWindow, RichEvent } from './adf-window.js';
import { everyRowEvent } from './flat-table.js';
import { everyRowKey } from './results.js';

const TABLE = 'r:app:mrph1:1:ap1:AT1:_ATp:ATt1';

const respond = (html: string): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

/** A movement request's lines table showing the given number of rows of `rowCount` (-1 when uncounted). */
const linesTable = (shown: number, rowCount: number, selected = '0'): RichResponse =>
  respond(
    `<div id="${TABLE}::db"><table _rowCount="${rowCount}" _startRow="0" _selState="{'${selected}':1}">` +
      Array.from({ length: shown }, (_, key) => `<tr _afrRK="${key}"><td>${key + 1}</td></tr>`).join('') +
      '</table></div>',
  );

/** A window that answers each event with the next of the responses given, keeping the events. */
const scriptedWindow = (...responses: RichResponse[]) => {
  const events: RichEvent[] = [];
  const adfWindow: AdfWindow = {
    homeHtml: '',
    submit: async event => {
      events.push(event);
      const next = responses.shift();
      if (!next) throw new Error('no response scripted for this event');
      return next;
    },
    download: async () => {
      throw new Error('no download scripted');
    },
  };
  return { adfWindow, events };
};

const FIELDS = { 'r:app:q1:value00': 'GA0081' };

describe('everyRowKey', () => {
  test('has every row rendered, keeping the selected row, and returns each row’s key', async () => {
    const { adfWindow, events } = scriptedWindow(linesTable(30, 30, '2'));
    expect(await everyRowKey(adfWindow, linesTable(17, -1, '2'), TABLE, FIELDS)).toHaveLength(30);
    expect(events).toEqual([everyRowEvent(TABLE, '2', FIELDS)]);
  });

  test('asks nothing of a table the page rendered whole, or one without rows', async () => {
    const { adfWindow, events } = scriptedWindow();
    expect(await everyRowKey(adfWindow, linesTable(13, 13), TABLE, FIELDS)).toHaveLength(13);
    expect(await everyRowKey(adfWindow, linesTable(0, 0), TABLE, FIELDS)).toEqual([]);
    expect(events).toEqual([]);
  });

  test('refuses a table rendered in part, or without its row count', async () => {
    const partial = scriptedWindow(linesTable(25, 30));
    await expect(everyRowKey(partial.adfWindow, linesTable(17, -1), TABLE, FIELDS)).rejects.toThrow(
      'The Oracle Fusion detail page holds 30 lines but rendered 25.',
    );
    const uncounted = scriptedWindow(linesTable(17, -1));
    await expect(everyRowKey(uncounted.adfWindow, linesTable(17, -1), TABLE, FIELDS)).rejects.toThrow(
      'The Oracle Fusion detail page holds an unknown number of lines but rendered 17.',
    );
  });
});
