import { describe, expect, test } from 'vitest';
import { buildCopyRangeBody } from './tools/copy-range.js';
import { buildCreatePivotTableBody } from './tools/create-pivot-table.js';
import { buildReplaceTextBody, replaceTextTarget } from './tools/replace-text.js';
import { buildWorkbookRestOptions, qualifiedRange, rangePath, worksheetPath } from './workbook-rest.js';

describe('workbook REST paths', () => {
  test('quotes sheet names and addresses as OData strings, doubling apostrophes', () => {
    expect(worksheetPath('Plugin Lab')).toBe("worksheets('Plugin Lab')");
    expect(rangePath("Bob's Sheet", 'A1:D5')).toBe("worksheets('Bob''s Sheet')/range(address='A1:D5')");
  });

  test('qualifies a range, quoting only sheet names Excel requires quoted', () => {
    expect(qualifiedRange('Sheet1', 'A1')).toBe('Sheet1!A1');
    expect(qualifiedRange('Plugin Lab', 'A1:D5')).toBe("'Plugin Lab'!A1:D5");
    expect(qualifiedRange('2024', 'A1')).toBe("'2024'!A1");
  });
});

describe('buildWorkbookRestOptions', () => {
  test('sends a read with the read flags and no body, as Excel does', () => {
    expect(buildWorkbookRestOptions('Get', 'worksheets')).toEqual({
      request: {
        HttpMethod: 'Get',
        PathAndQuery: 'worksheets',
        RequestHeaders: null,
        RequestBody: '',
        RequestFlags: 256,
      },
    });
  });

  test('sends a write as JSON with the write flags', () => {
    expect(buildWorkbookRestOptions('Patch', "worksheets('A')", { tabColor: '#00B050' })).toEqual({
      request: {
        HttpMethod: 'Patch',
        PathAndQuery: "worksheets('A')",
        RequestHeaders: [{ Name: 'Content-Type', Value: 'application/json' }],
        RequestBody: '{"tabColor":"#00B050"}',
        RequestFlags: 1,
      },
    });
  });
});

describe('tool bodies', () => {
  test('copy_range maps the paste option to its copyType', () => {
    expect(buildCopyRangeBody('Plugin Lab', 'A1:D5', 'values', false, true)).toEqual({
      sourceRange: "'Plugin Lab'!A1:D5",
      copyType: 'Values',
      skipBlanks: false,
      transpose: true,
    });
  });

  test('replace_text searches the used range when no address is given', () => {
    expect(replaceTextTarget('Sheet1')).toBe("worksheets('Sheet1')/usedRange");
    expect(replaceTextTarget('Sheet1', 'B2:C9')).toBe("worksheets('Sheet1')/range(address='B2:C9')");
    expect(buildReplaceTextBody('Gadget', 'Doohickey', true, false)).toEqual({
      text: 'Gadget',
      replacement: 'Doohickey',
      criteria: { completeMatch: false, matchCase: true },
    });
  });

  test('create_pivot_table qualifies both the source and the destination', () => {
    expect(buildCreatePivotTableBody('ItemPivot', 'Plugin Lab', 'A1:D5', 'Report', 'B3')).toEqual({
      name: 'ItemPivot',
      source: "'Plugin Lab'!A1:D5",
      destination: 'Report!B3',
    });
  });
});
