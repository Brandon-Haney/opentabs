import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  EXPECTED_SHIPMENT_DOCUMENTS,
  type ExpectedShipmentDocument,
  expectedShipmentCriteria,
  expectedShipmentsScreen,
  unknownDocuments,
} from '../receiving.js';
import { SearchRejectedError } from '../search-screen.js';
import { expectedShipmentSchema, mapExpectedShipment } from './schemas.js';

/** Documents a partial number may match before the search is refused; each is searched on its own. */
const MAX_MATCHED_DOCUMENTS = 25;

const documentSchema = (what: string) =>
  z.string().optional().describe(`${what} number. With partial_match, any part of the number`);

const documentResultSchema = z.object({
  field: z
    .enum(['purchase_order', 'asn', 'transfer_order', 'in_transit_shipment', 'rma'])
    .describe('Which document field the number was searched in'),
  number: z.string().describe('The document number; with partial_match and no match, the text that was searched for'),
  status: z
    .enum(['open', 'no_open_lines', 'not_found', 'not_checked'])
    .describe(
      'open: Fusion knows the number and has lines matching the search to receive. no_open_lines: Fusion ' +
        'knows the number, but no line matching the search is waiting to be received (received already, ' +
        'cancelled, or filtered out by the other criteria). not_found: receiving in this organization does not ' +
        'know the number (or, with partial_match, no number contains the text) — the document may not exist, ' +
        'may belong to another organization, or may not have become receivable yet, e.g. an RMA that failed ' +
        'in Order Management. not_checked: another number in the same search was not found, so this one was ' +
        'not searched',
    ),
  open_lines: z.number().int().describe('Number of expected lines the search returned for this document'),
});

type DocumentResult = z.infer<typeof documentResultSchema>;
type DocumentStatus = DocumentResult['status'];

/** Expected lines and per-document results of one or more searches. */
interface ShipmentSearch {
  shipments: (ReturnType<typeof mapExpectedShipment> & { matched_document: string })[];
  documents: DocumentResult[];
}

export const searchExpectedShipments = defineTool({
  name: 'search_expected_shipments',
  displayName: 'Search Expected Shipments',
  description:
    'Search shipment lines the store expects to receive but has not received yet — the Receive Expected ' +
    'Shipments page in the Receipts tasks of Inventory Management. Covers open purchase order lines, advance ' +
    'shipment notices (ASN), transfer orders, in-transit shipments and customer returns (RMA). A line that is ' +
    'missing here was either received already or never became expected. Each document number searched comes ' +
    'back with a status: open, no_open_lines (known but nothing waiting) or not_found (receiving does not know ' +
    'the number). At least one of purchase_order, asn, ' +
    'transfer_order, in_transit_shipment, rma, supplier or item is required. Document numbers match exactly; ' +
    'set partial_match to find documents by part of one number (e.g., "ATL001-ZZZ08"), which searches each ' +
    `matching document, up to ${MAX_MATCHED_DOCUMENTS}. Covers the inventory organization Fusion has selected ` +
    'for the work area. Runs in a background session.',
  summary: 'Search open PO, ASN, transfer and RMA lines awaiting receipt',
  icon: 'truck',
  group: 'Receiving',
  input: z.object({
    purchase_order: documentSchema('Purchase order'),
    asn: documentSchema('Advance shipment notice (ASN)'),
    transfer_order: documentSchema('Transfer order'),
    in_transit_shipment: documentSchema('In-transit shipment'),
    rma: documentSchema('Return material authorization (RMA)'),
    partial_match: z
      .boolean()
      .optional()
      .describe(
        'Treat the one document number given as part of a number and search every document containing it ' +
          '(default false). Exactly one document number must be given',
      ),
    supplier: z.string().optional().describe('Supplier name, exactly as Fusion lists it (e.g., "ATL ATLANTA DC")'),
    item: z.string().optional().describe('Exact item number'),
    due_date: z
      .string()
      .optional()
      .describe(
        'Due date range, exactly as the page lists it: "Today", "All past due", "From today and the past 30 ' +
          'days", "From today and the next 3 days", and so on. Omit for any due date',
      ),
  }),
  output: z.object({
    shipments: z
      .array(
        expectedShipmentSchema.extend({
          matched_document: z
            .string()
            .describe(
              'With partial_match, the document number the line was found by (an ASN line shows its purchase ' +
                'order as document_number); empty otherwise',
            ),
        }),
      )
      .describe('Expected shipment lines, in the order Fusion lists them'),
    documents: z
      .array(documentResultSchema)
      .describe(
        'What the search found for each document number: the numbers given, or with partial_match every ' +
          'number that contained the text. Empty when the search named no document',
      ),
  }),
  handle: async (params, context) => {
    const report = (message: string) => context?.reportProgress({ message });
    const given = (Object.keys(EXPECTED_SHIPMENT_DOCUMENTS) as ExpectedShipmentDocument[]).filter(
      field => params[field],
    );
    if (given.length === 0 && !params.supplier && !params.item) {
      throw ToolError.validation(
        'Provide at least one of purchase_order, asn, transfer_order, in_transit_shipment, rma, supplier or item.',
      );
    }

    /**
     * Searches with the given document numbers. A number the document field does not know is
     * refused by Fusion before the search runs; that refusal is reported as the number not being
     * found, with any other number in the same search left unchecked.
     */
    const searchDocuments = async (
      documents: Partial<Record<ExpectedShipmentDocument, string>>,
      matchedDocument: string,
    ): Promise<ShipmentSearch> => {
      const named = (Object.keys(documents) as ExpectedShipmentDocument[]).filter(field => documents[field]);
      try {
        const rows = await expectedShipmentsScreen.search(
          expectedShipmentCriteria(documents, {
            supplier: params.supplier,
            item: params.item,
            dueDate: params.due_date,
          }),
          report,
        );
        const status: DocumentStatus = rows.length > 0 ? 'open' : 'no_open_lines';
        return {
          shipments: rows.map(row => ({ ...mapExpectedShipment(row), matched_document: matchedDocument })),
          documents: named.map(field => ({ field, number: documents[field] ?? '', status, open_lines: rows.length })),
        };
      } catch (error) {
        const unknown = error instanceof SearchRejectedError ? unknownDocuments(error, named) : null;
        if (!unknown) throw error;
        return {
          shipments: [],
          documents: named.map(field => ({
            field,
            number: documents[field] ?? '',
            status: unknown.has(field) ? 'not_found' : 'not_checked',
            open_lines: 0,
          })),
        };
      }
    };

    if (!params.partial_match) {
      return searchDocuments(Object.fromEntries(given.map(field => [field, params[field]])), '');
    }

    const [partialField, ...others] = given;
    if (!partialField || others.length > 0) {
      throw ToolError.validation('partial_match needs exactly one document number (purchase_order, asn, and so on).');
    }
    const text = params[partialField] ?? '';
    const found = await expectedShipmentsScreen.lookup(EXPECTED_SHIPMENT_DOCUMENTS[partialField], text, report);
    const matches = [...new Set(found.rows.map(row => row[0] ?? '').filter(Boolean))];
    if (matches.length === 0) {
      return {
        shipments: [],
        documents: [{ field: partialField, number: text, status: 'not_found' as const, open_lines: 0 }],
      };
    }
    if (matches.length > MAX_MATCHED_DOCUMENTS) {
      throw ToolError.validation(
        `${matches.length} documents contain "${text}", more than the ${MAX_MATCHED_DOCUMENTS} one call ` +
          `searches. Give more of the number. First matches: ${matches.slice(0, 10).join(', ')}.`,
      );
    }

    const result: ShipmentSearch = { shipments: [], documents: [] };
    for (const [index, document] of matches.entries()) {
      report(`Searching ${document} (${index + 1} of ${matches.length})`);
      const searched = await searchDocuments({ [partialField]: document }, document);
      result.shipments.push(...searched.shipments);
      result.documents.push(...searched.documents);
    }
    return result;
  },
});
