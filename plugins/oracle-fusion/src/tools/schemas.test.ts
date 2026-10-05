import { describe, expect, test } from 'vitest';
import {
  mapCompletedTransactionDetails,
  mapExpectedShipment,
  mapItemQuantity,
  mapMovementRequest,
  mapMovementRequestLine,
  mapPendingTransaction,
  mapPendingTransactionDetails,
  mapPurchaseOrder,
  mapPurchaseOrderLine,
  shiftIsoDate,
} from './schemas.js';

describe('shiftIsoDate', () => {
  test.each([
    ['2026-09-01', -1, '2026-08-31'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
  ])('moves %s by %i days', (date, days, expected) => {
    expect(shiftIsoDate(date, days)).toBe(expected);
  });
});

describe('mapItemQuantity', () => {
  test('fills every level from the row and its ancestors', () => {
    expect(
      mapItemQuantity({
        label: 'Locator B1.01',
        ancestorLabels: ['Item A-1', 'Organization M1', 'Subinventory STORES'],
        values: { 'On Hand': '-1', Receiving: '', Inbound: '1,200', 'UOM Name': 'EACH' },
        itemDescription: 'Widget',
        availability: {
          Total: { 'On Hand': '-1', Total: '1,199' },
          'Available to Transact': { 'On Hand': '0' },
          'Available to Reserve': { 'On Hand': '' },
        },
      }),
    ).toEqual({
      level: 'locator',
      name: 'B1.01',
      item: 'A-1',
      item_description: 'Widget',
      organization: 'M1',
      subinventory: 'STORES',
      locator: 'B1.01',
      on_hand: -1,
      receiving: null,
      inbound: 1200,
      uom: 'EACH',
      available_to_transact: 0,
      available_to_reserve: null,
    });
  });

  test('keeps an unrecognized level by its full label', () => {
    const row = mapItemQuantity({
      label: 'Lot L-7',
      ancestorLabels: ['Item A-1'],
      values: {},
      itemDescription: '',
    });
    expect(row).toMatchObject({ level: 'other', name: 'Lot L-7', item: 'A-1', on_hand: null, uom: '' });
  });

  test('leaves availability out when it was not read, and reports a blank as null when it was', () => {
    const node = { label: 'Item A-1', ancestorLabels: [], values: {}, itemDescription: '' };
    expect(mapItemQuantity(node)).not.toHaveProperty('available_to_reserve');
    expect(mapItemQuantity({ ...node, availability: {} })).toMatchObject({
      available_to_transact: null,
      available_to_reserve: null,
    });
  });
});

describe('pending transactions', () => {
  test('maps the exported columns', () => {
    expect(
      mapPendingTransaction({
        'Transaction ID': '1001',
        'Transaction Process Status': 'Staged',
        Item: 'A-1',
        Subinventory: 'STORES',
        'Transaction Quantity': '-3',
        'Transaction UOM': 'EACH',
        'Transaction Date': '2026-09-01 20:00:00',
        'Transaction Type': 'Subinventory Transfer',
        'Processing Status': 'Error during processing',
        'Error Explanation': 'Invalid locator.',
      }),
    ).toEqual({
      transaction_id: '1001',
      processing_status: 'Error during processing',
      process_status: 'Staged',
      error_explanation: 'Invalid locator.',
      item: 'A-1',
      subinventory: 'STORES',
      transaction_quantity: -3,
      uom: 'EACH',
      transaction_date: '2026-09-01 20:00:00',
      transaction_type: 'Subinventory Transfer',
    });
  });

  test('lifts the key detail fields and keeps every field', () => {
    const details = { Error: 'E1', Locator: 'B1', 'Destination Subinventory': 'RETURN', 'Custom Field': 'x' };
    expect(mapPendingTransactionDetails(details)).toMatchObject({
      error_code: 'E1',
      locator: 'B1',
      destination_subinventory: 'RETURN',
      destination_locator: '',
      details,
    });
  });
});

describe('completed transaction details', () => {
  test('lifts the detail and About This Record fields and keeps every detail field', () => {
    const details = {
      'Transaction Type': 'Subinventory Transfer',
      'Transaction Action': 'Subinventory transfer',
      'Transfer Subinventory': 'SALESFLOOR',
      'Transfer Locator': 'E01.02',
      'Transfer Transaction': '348043',
      'Store # - Invoice #': 'Initial on hand GO-LIVE',
    };
    const audit = {
      'Created By': '100000',
      'Last Updated By': 'SVC_FUSION_SCHEDULE_P',
      'Last Update Date': '9/21/26 3:05 PM',
    };
    expect(mapCompletedTransactionDetails(details, audit)).toEqual({
      transaction_type: 'Subinventory Transfer',
      transaction_action: 'Subinventory transfer',
      reason: '',
      transfer_organization: '',
      transfer_subinventory: 'SALESFLOOR',
      transfer_locator: 'E01.02',
      transfer_transaction: '348043',
      created_by: '100000',
      last_updated_by: 'SVC_FUSION_SCHEDULE_P',
      last_update_date: '9/21/26 3:05 PM',
      details,
    });
  });

  test('leaves every field empty when nothing was read', () => {
    expect(mapCompletedTransactionDetails({}, {})).toMatchObject({ transaction_type: '', created_by: '', details: {} });
  });
});

describe('expected shipments', () => {
  test('maps the columns of a result row', () => {
    expect(
      mapExpectedShipment({
        Organization: 'GA0001',
        Item: '4885667-NB',
        'Item Description': 'BRAKE ROTOR ONLY',
        'Document Number': 'ATL001-ZZZ08797',
        Quantity: '2',
        'Document Line': '28',
        'Document Schedule': '1',
        'Due Date': '10/24/25',
        'UOM Name': 'EACH',
      }),
    ).toEqual({
      organization: 'GA0001',
      item: '4885667-NB',
      item_description: 'BRAKE ROTOR ONLY',
      document_number: 'ATL001-ZZZ08797',
      quantity: 2,
      document_line: '28',
      document_schedule: '1',
      due_date: '10/24/25',
      uom: 'EACH',
    });
  });
});

describe('movement request lines', () => {
  test('maps the named columns and keeps the rest', () => {
    const line = mapMovementRequestLine({
      'Movement Request': 'ATL001-100004',
      'Line Number': '1',
      Item: '2349017-DEN',
      'Requested Quantity': '1',
      'Delivered Quantity': '',
      'Source Subinventory': 'BACKSTOCK',
      'Source Locator': 'SPO.01.01',
      'Destination Subinventory': 'STAGING',
      'Line Status': 'Preapproved',
      Lot: 'L1',
    });
    expect(line).toMatchObject({
      movement_request: 'ATL001-100004',
      line_number: '1',
      item: '2349017-DEN',
      requested_quantity: 1,
      delivered_quantity: 0,
      source_subinventory: 'BACKSTOCK',
      source_locator: 'SPO.01.01',
      destination_subinventory: 'STAGING',
      destination_locator: '',
      line_status: 'Preapproved',
      additional_columns: { Lot: 'L1' },
    });
  });
});

describe('movement requests', () => {
  test('lifts the order fields and maps each pick', () => {
    const details = {
      'Movement Request': 'ATL001-100003',
      Description: 'SAMPLE AUTO SERVICE',
      Status: 'Preapproved',
      'Customer Name': 'SAMPLE AUTO SERVICE',
      'Customer PO#': '10001',
      'TAMS Order#': '200001',
    };
    const request = mapMovementRequest(details, [
      {
        'Movement Request Line': '1',
        'Pick Status': 'Confirmed',
        'Requested Quantity': '1',
        'Source Subinventory': 'BACKSTOCK',
        'Source Locator': '110.02.00',
        'Picked Quantity': '1',
        'UOM Name': '1',
      },
    ]);
    expect(request).toMatchObject({
      movement_request: 'ATL001-100003',
      customer_name: 'SAMPLE AUTO SERVICE',
      customer_po: '10001',
      tams_order: '200001',
      customer_number: '',
      details,
      picks: [
        {
          line_number: '1',
          pick_status: 'Confirmed',
          requested_quantity: 1,
          picked_quantity: 1,
          source_subinventory: 'BACKSTOCK',
          source_locator: '110.02.00',
        },
      ],
    });
  });
});

describe('purchase orders', () => {
  test('maps an order row, reading the total as a number', () => {
    expect(
      mapPurchaseOrder({
        Order: 'ATL001-ZZZ09207',
        Supplier: 'ATL ATLANTA DC',
        Status: 'Open',
        'Total (Excluding Tax)': '3,034.52 USD',
        Buyer: 'Someone',
      }),
    ).toMatchObject({
      order: 'ATL001-ZZZ09207',
      status: 'Open',
      total: 3034.52,
      additional_columns: { Buyer: 'Someone' },
    });
  });

  test('maps a line, lifting the receiving quantities and dropping empty columns', () => {
    const line = mapPurchaseOrderLine({
      Line: '1',
      Item: '380007-NSE',
      Quantity: '1',
      Price: '2.22',
      Total: '2.22',
      Status: 'Open',
      received_qty: '0',
      backordered_qty: '1',
      damaged_qty: '',
      promo_cd: '',
    });
    expect(line).toMatchObject({
      line: '1',
      quantity: 1,
      price: 2.22,
      received_quantity: 0,
      backordered_quantity: 1,
      damaged_quantity: null,
    });
    expect(line.columns).not.toHaveProperty('promo_cd');
  });
});
