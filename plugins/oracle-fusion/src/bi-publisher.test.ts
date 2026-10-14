import { describe, expect, test } from 'vitest';
import {
  parseReportError,
  parseReportLabels,
  parseReportPage,
  parseReportRowValue,
  parseReportTable,
  parseStatusUrl,
  reportPageUrl,
} from './bi-publisher.js';

const reportPage =
  '<html><body><form name="xdoRptForm" id="xdoRptForm">' +
  '<input type="hidden" name="_sTkn" value="abc123"><input type="hidden" name="_xdo" value="/Custom/R.xdo">' +
  '<input id="_paramsP_From_Date" name="_paramsP_From_Date" type="text" data-datepattern="MM/dd/yyyy" data-paramtype="date" value="">' +
  '<input type="hidden" name="_xt" value="Pending Credit Issuance"><input type="hidden" name="_xf" value="analyze">' +
  '</form><script>' +
  "new MultiChoiceList('xdo:_paramsP_Store_Number_div', '_paramsP_Store_Number', [['ATL081', 'ATL081']], false, 'x');" +
  "new MultiChoiceList('xdo:_paramsP_Return_Type_div', '_paramsP_Return_Type', [['C1 - Defect Return (Blk Label)', " +
  "'C1 - Defect Return (Blk Label)'],['CH - Battery Core Return', 'CH - Battery Core Return']], false, 'x');" +
  '</script></body></html>';

describe('report pages', () => {
  test('builds a report page URL from its catalog path', () => {
    expect(reportPageUrl('/Custom/Reports/R-442 Print RGN Report/R-442 Print RGN Report.xdo')).toBe(
      '/xmlpserver/Custom/Reports/R-442%20Print%20RGN%20Report/R-442%20Print%20RGN%20Report.xdo',
    );
  });

  test('reads the form, date patterns and list choices', () => {
    const form = parseReportPage(reportPage);
    expect(form?.fields).toEqual([
      ['_sTkn', 'abc123'],
      ['_xdo', '/Custom/R.xdo'],
      ['_paramsP_From_Date', ''],
      ['_xt', 'Pending Credit Issuance'],
      ['_xf', 'analyze'],
    ]);
    expect(form?.datePatterns.get('P_From_Date')).toBe('MM/dd/yyyy');
    expect([...(form?.choices.get('P_Return_Type')?.keys() ?? [])]).toEqual([
      'C1 - Defect Return (Blk Label)',
      'CH - Battery Core Return',
    ]);
    expect(form?.choices.get('P_Store_Number')?.get('ATL081')).toBe('ATL081');
  });

  test('returns null for a page without a report form', () => {
    expect(parseReportPage('<html><body>Sign in</body></html>')).toBeNull();
  });

  test('reads the status URL of a loading page', () => {
    const loading =
      'function runStatusCheck() { var url = "/xmlpserver/servlet/xdo?_xdo=%2FR.xdo&fromLoadingPage=true&_id=42"; }';
    expect(parseStatusUrl(loading)).toBe('/xmlpserver/servlet/xdo?_xdo=%2FR.xdo&fromLoadingPage=true&_id=42');
    expect(parseStatusUrl('<html></html>')).toBeNull();
  });

  test('reads the error a report answered with', () => {
    const error =
      '<div>Error</div><table id="errordetailtable"><tr><td>Invalid format requested: csv</td></tr></table>';
    expect(parseReportError(error)).toBe('Invalid format requested: csv');
    expect(parseReportError('<table><tr><td>data</td></tr></table>')).toBeNull();
  });
});

describe('report output', () => {
  const output =
    '<table><tr><td></td><td>Pending Credit Issuance</td></tr></table>' +
    '<table><tr><td>Return Type</td><td>RGN Number</td><td>Quantity</td></tr>' +
    '<tr><td>CH - Battery Core Return</td><td><a href="/fscmUI/faces/deeplink?objKey=InvoiceId=300">ATL081-100310</a></td><td>61.00</td></tr>' +
    '<tr><td></td><td></td><td></td></tr>' +
    '<tr><td>C7 - OSD to DC</td><td>ATL081-100384</td><td>6.00</td></tr>' +
    '<tr><td></td><td>Total</td><td>67.00</td></tr></table>';

  test('reads the table under a heading row, with its totals and links', () => {
    const table = parseReportTable(output, 'Return Type');
    expect(table.headings).toEqual(['Return Type', 'RGN Number', 'Quantity']);
    expect(table.rows).toEqual([
      {
        values: { 'Return Type': 'CH - Battery Core Return', 'RGN Number': 'ATL081-100310', Quantity: '61.00' },
        links: ['/fscmUI/faces/deeplink?objKey=InvoiceId=300'],
      },
      { values: { 'Return Type': 'C7 - OSD to DC', 'RGN Number': 'ATL081-100384', Quantity: '6.00' }, links: [] },
    ]);
    expect(table.totals).toEqual({ 'Return Type': '', 'RGN Number': 'Total', Quantity: '67.00' });
  });

  test('reads a report without the table as empty', () => {
    expect(parseReportTable('<table><tr><td>Nothing</td></tr></table>', 'Return Type')).toEqual({
      headings: [],
      rows: [],
      totals: null,
    });
  });

  test('reads header labels, leaving a label empty when the next cell is another label', () => {
    const header =
      '<table><tr><td>RGN Date:</td><td>08/26/2026</td></tr>' +
      '<tr><td>Reference:</td><td></td><td></td><td>RGN Number:</td><td>ATL081-100310</td></tr>' +
      '<tr><td>Notes</td><td>Two cores damaged</td></tr></table>';
    expect(parseReportLabels(header)).toEqual({
      'RGN Date': '08/26/2026',
      Reference: '',
      'RGN Number': 'ATL081-100310',
    });
    expect(parseReportRowValue(header, 'Notes')).toBe('Two cores damaged');
    expect(parseReportRowValue(header, 'Description')).toBe('');
  });
});
