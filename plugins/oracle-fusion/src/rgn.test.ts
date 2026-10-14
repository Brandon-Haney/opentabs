import { describe, expect, test } from 'vitest';
import { itemOf, mapRgn, mapRgnLine, parseDashboardCounts, reportDate, reportNumber } from './rgn.js';

describe('report values', () => {
  test('reads amounts and quantities, with blanks as null', () => {
    expect(reportNumber('1,292.00')).toBe(1292);
    expect(reportNumber('-657.72')).toBe(-657.72);
    expect(reportNumber('')).toBeNull();
    expect(reportNumber('NA')).toBeNull();
  });

  test('reads report dates as ISO dates and leaves other text alone', () => {
    expect(reportDate('08/26/2026')).toBe('2026-08-26');
    expect(reportDate('NA')).toBe('NA');
    expect(reportDate(undefined)).toBe('');
  });

  test('builds the Fusion item from the part number and line', () => {
    expect(itemOf('8229CORE', 'BAT')).toBe('8229CORE-BAT');
    expect(itemOf('8229CORE', '')).toBe('8229CORE');
  });
});

describe('RGN rows', () => {
  test('maps a reconciliation row with the debit memo id from its link', () => {
    const rgn = mapRgn(
      {
        values: {
          'Return Type': 'CH - Battery Core Return',
          Store: 'ATL081',
          'RGN Number': 'ATL081-100310',
          'RGN Date': '08/26/2026',
          Quantity: '61.00',
          'Credit Requested in $': '1,292.00',
          'Credit Received in $': '0.00',
          'Last Credit Received Date': '',
          Status: 'Pending Credit Issuance',
        },
        links: ['https://x/fscmUI/faces/deeplink?objType=AP_VIEWINVOICE&objKey=InvoiceId=300000082947577'],
      },
      'pending_credit',
    );
    expect(rgn).toMatchObject({
      stage: 'pending_credit',
      rgn_number: 'ATL081-100310',
      rgn_date: '2026-08-26',
      quantity: 61,
      credit_requested: 1292,
      credit_received: 0,
      last_credit_received_date: '',
      invoice_id: '300000082947577',
    });
  });

  test('maps a printed RGN line to its Fusion item', () => {
    expect(
      mapRgnLine({
        values: {
          'Line Abbrv': 'BAT',
          'Part Number': '8229CORE',
          'Requested Quantity': '2.00',
          'Requested Core Cost ($)': '10.00',
          'Requested Amount ($)': '20.00',
          'Credited Quantity': '0.00',
          'Variance ($)': '20.00',
        },
        links: [],
      }),
    ).toMatchObject({
      item: '8229CORE-BAT',
      requested_quantity: 2,
      requested_amount: 20,
      credited_quantity: 0,
      variance: 20,
    });
  });
});

describe('parseDashboardCounts', () => {
  test('pairs each tile label with the count beneath it', () => {
    const html =
      '<table><tr><td></td><td>RGN Reconciliation Dashboard</td></tr>' +
      '<tr><td>Return Bank</td><td></td><td>Pending Store Manager Review RGN</td><td></td><td>Pending Credit Issuance</td><td></td><td>RGN / OS&amp;D Variance</td></tr>' +
      '<tr><td>0</td><td></td><td>0</td><td></td><td>5</td><td></td><td>0</td></tr>' +
      '<tr><td>Unidentified Credit Issuance</td><td></td><td>Reconciled RGN (0-60 Days)</td><td></td>' +
      '<td>Reconciled RGN With Financial Adj.(0-60 Days)</td><td></td><td>Reconciled RGN With No Financial Adj.(0-60 Days)</td></tr>' +
      '<tr><td>77</td><td></td><td>7</td><td></td><td>0</td><td></td><td>1,204</td></tr></table>';
    expect(parseDashboardCounts(html)).toEqual({
      return_bank: 0,
      pending_store_manager_review: 0,
      pending_credit: 5,
      osd_variance: 0,
      unidentified_credit: 77,
      reconciled: 7,
      reconciled_with_financial_adjustment: 0,
      reconciled_without_financial_adjustment: 1204,
    });
  });
});
