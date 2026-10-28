import { describe, expect, it } from 'vitest';
import { blankWorkbookBytes } from './blank-xlsx.js';
import { OoxmlPackage } from './ooxml.js';

describe('blank workbook', () => {
  const pkg = OoxmlPackage.open(blankWorkbookBytes());

  it('holds exactly the parts a blank workbook needs', () => {
    expect(pkg.partNames().sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('has one empty sheet named Sheet1', async () => {
    expect(await pkg.partText('xl/workbook.xml')).toContain(
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>',
    );
    expect(await pkg.partText('xl/worksheets/sheet1.xml')).toContain('<sheetData/>');
  });

  it('declares a content type for every part it overrides', async () => {
    const contentTypes = (await pkg.partText('[Content_Types].xml')) ?? '';
    for (const part of ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) {
      expect(contentTypes).toContain(`PartName="/${part}"`);
    }
  });

  it('returns a fresh copy each call', () => {
    const first = blankWorkbookBytes();
    first[0] = 0;
    expect(blankWorkbookBytes()[0]).toBe(0x50);
  });
});
