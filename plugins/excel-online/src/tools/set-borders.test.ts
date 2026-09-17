import { describe, expect, test } from 'vitest';
import { borderColorValue, borderEdgeMask, borderLineStyle, buildSetBordersOptions } from './set-borders.js';

describe('set_borders', () => {
  test('combines edges into the bitmask the editor sends', () => {
    expect(borderEdgeMask(['bottom'])).toBe(1);
    expect(borderEdgeMask(['top', 'left', 'right'])).toBe(14);
    expect(borderEdgeMask(['outline'])).toBe(64);
    expect(borderEdgeMask(['all'])).toBe(112);
    expect(borderEdgeMask(['inside'])).toBe(48);
  });

  test('maps style and weight to the captured line-style codes', () => {
    expect(borderLineStyle('Continuous', 'Thin')).toBe(1);
    expect(borderLineStyle('Continuous', 'Medium')).toBe(2);
    expect(borderLineStyle('Dash', 'Thin')).toBe(3);
    expect(borderLineStyle('Dot', 'Thin')).toBe(4);
    expect(borderLineStyle('Continuous', 'Thick')).toBe(5);
    expect(borderLineStyle('Double', 'Thin')).toBe(6);
    expect(borderLineStyle('Continuous', 'Hairline')).toBe(7);
    expect(borderLineStyle('Dash', 'Medium')).toBe(8);
  });

  test('encodes a colour with its bytes in blue-green-red order', () => {
    expect(borderColorValue('#FF0000')).toBe(255);
    expect(borderColorValue('#00B050')).toBe(5287936);
    expect(borderColorValue('#000000')).toBe(0);
  });

  test('clears every border with an empty mask, as No Border does', () => {
    const options = buildSetBordersOptions('Plugin Lab', 'A8:E11', ['all'], 'None', 'Thin', '#000000');
    expect(options.format).toMatchObject({ Border: 0, ValidMembers: 128 });
  });

  test('targets the range and repeats the style and colour for each slot', () => {
    const options = buildSetBordersOptions('Plugin Lab', 'A22:C24', ['outline'], 'Continuous', 'Thick', '#1F4E78');
    expect(options.formatCellsMultiRange).toEqual({
      SheetName: 'Plugin Lab',
      NamedObjectName: '',
      Ranges: [{ FirstRow: 21, LastRow: 23, FirstColumn: 0, LastColumn: 2 }],
    });
    expect(options.format).toEqual({
      BorderFormat: { Color: [7884319, 7884319, 7884319, 7884319], LineStyle: [5, 5, 5, 5] },
      ValidMembers: 128,
      Border: 64,
    });
  });
});
