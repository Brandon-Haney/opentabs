import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import type { RichResponse } from '../adf-protocol.js';
import type { AdfWindow } from '../adf-window.js';
import { findRowLink, parseDetailFields } from '../detail-page.js';
import {
  PURCHASE_ORDERS_WORK_AREA_SETTING_LABEL,
  purchaseOrderCriteria,
  purchaseOrdersWorkArea,
} from '../procurement.js';
import {
  type CloseAnswer,
  chooseActionEvent,
  confirmCloseEvent,
  type ExpectedQuantities,
  expectedQuantities,
  findCloseLineCommand,
  findOrderLinesTable,
  judgeCloseAnswer,
  type LineToClose,
  parseOrderLines,
  parseRenderedOrderLines,
  readCloseLineDialog,
  refusalFor,
  selectLineEvent,
} from '../purchase-order-lines.js';
import { expectedShipmentCriteria, expectedShipmentsScreen, unknownDocuments } from '../receiving.js';
import { closeDetailPage, exportDetailTable, openRowDetail } from '../results.js';
import { menuItemEvent } from '../row-actions.js';
import { createSearchScreen, type ResultsReader, SearchRejectedError, type StatusReporter } from '../search-screen.js';
import { mapExpectedShipment, mapPurchaseOrderLine } from './schemas.js';

/** Lines one call may close. */
const MAX_LINES = 25;

/** Longest reason the Close Line dialog accepts. */
const MAX_REASON_LENGTH = 240;

/**
 * Time after the call starts beyond which no further line is started. A tool call is cut off
 * after five minutes; what remains is enough to read the order back.
 */
const CLOSING_BUDGET_MS = 200_000;

/** Each action: the option Fusion lists it as in the Close Line dialog, and the status a line takes. */
const ACTIONS = {
  close: { option: 'Close', status: 'Closed' },
  close_for_receiving: { option: 'Close for Receiving', status: 'Closed for Receiving' },
  close_for_invoicing: { option: 'Close for Invoicing', status: 'Closed for Invoicing' },
} as const;

type CloseAction = keyof typeof ACTIONS;

/** What one call asks the order page to do. */
interface CloseRequest {
  order: string;
  lines: LineToClose[];
  action: CloseAction;
  reason: string;
  expected: ExpectedQuantities;
  /** Time after which no further line is started. */
  deadline: number;
}

type Outcome = 'closed' | 'skipped' | 'failed' | 'not_attempted';

/** What happened to one line. */
interface LineResult {
  line: number;
  item: string;
  outcome: Outcome;
  detail: string;
  status_before: string | null;
  status_after: string | null;
}

/** The lines of a call as they stand while it runs, with Fusion's answer to each OK sent. */
interface LineProgress extends LineResult {
  /** Fusion's answer to OK, or what went wrong once OK was sent; set only for lines whose OK was sent. */
  answer: CloseAnswer | null;
}

interface CloseRun {
  orderStatus: string | null;
  verified: boolean;
  lines: LineResult[];
}

/** The order as read back after closing: its status and each line's status by line number. */
interface ReadBack {
  orderStatus: string | null;
  statuses: Map<number, string>;
}

/** Thrown while closing one line, carrying whether OK had been sent when it happened. */
class LineCloseError extends Error {
  constructor(
    message: string,
    readonly okSent: boolean,
  ) {
    super(message);
    this.name = 'LineCloseError';
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Closes one line: selects it with every line redrawn, checks it once more as Fusion holds
 * it now, opens Close, chooses the action, enters the reason and answers OK. Returns the
 * reason to skip the line when the fresh check refuses it, or Fusion's answer to OK.
 */
const closeLine = async (
  adfWindow: AdfWindow,
  tableId: string,
  closeCommand: string,
  wanted: LineToClose,
  rowKey: string,
  request: CloseRequest,
): Promise<{ skipped: string } | { answer: CloseAnswer }> => {
  let okSent = false;
  try {
    const shown = parseRenderedOrderLines(await adfWindow.submit(selectLineEvent(tableId, rowKey)), tableId);
    const fresh = shown.lines.find(line => line.line === wanted.line);
    if (fresh && fresh.rowKey !== rowKey) {
      throw new LineCloseError(`Line ${wanted.line} moved in the lines table while the call ran.`, false);
    }
    const refusal = refusalFor(wanted, fresh, request.expected);
    if (refusal) return { skipped: refusal };

    const closing = readCloseLineDialog(await adfWindow.submit(menuItemEvent(closeCommand, {})));
    const { option } = ACTIONS[request.action];
    const value = closing.actions.get(option);
    if (value === undefined) {
      throw new LineCloseError(
        `The Close Line dialog offers no "${option}" action (it offers ${[...closing.actions.keys()].join(', ')}).`,
        false,
      );
    }

    const fields = { ...closing.fields, [closing.actionField]: value };
    if (closing.fields[closing.actionField] !== value) {
      const changed = await adfWindow.submit(chooseActionEvent(closing, fields));
      if (changed.messages.length > 0) {
        throw new LineCloseError(
          `Oracle Fusion answered the choice of ${option} with: ${changed.messages.map(m => m.text).join(' ')}`,
          false,
        );
      }
    }

    okSent = true;
    const answered = await adfWindow.submit(
      confirmCloseEvent(closing, { ...fields, [closing.reasonField]: request.reason }),
    );
    return { answer: judgeCloseAnswer(answered, closing) };
  } catch (error) {
    if (error instanceof LineCloseError) throw error;
    throw new LineCloseError(
      okSent ? `No usable answer from Oracle Fusion after OK: ${messageOf(error)}` : messageOf(error),
      okSent,
    );
  }
};

/**
 * Closes the lines one at a time, recording on each what happened. Stops at the first line
 * that fails or does not close cleanly, and before any line once the deadline has passed;
 * the lines after it are left alone and marked as not started.
 */
const closeEach = async (
  adfWindow: AdfWindow,
  tableId: string,
  closeCommand: string,
  toClose: { line: LineProgress; rowKey: string }[],
  request: CloseRequest,
  report: StatusReporter,
): Promise<void> => {
  let stopped: string | null = null;
  for (const [index, { line, rowKey }] of toClose.entries()) {
    if (!stopped && Date.now() > request.deadline) {
      stopped = 'Not started: the call ran out of time. Call again for the lines not attempted.';
    }
    if (stopped) {
      line.detail = stopped;
      continue;
    }

    report(`Closing line ${line.line} (${index + 1} of ${toClose.length})`);
    try {
      const result = await closeLine(adfWindow, tableId, closeCommand, line, rowKey, request);
      if ('skipped' in result) {
        line.outcome = 'skipped';
        line.detail = result.skipped;
        continue;
      }
      line.answer = result.answer;
      if (!result.answer.saved) stopped = `Not started: line ${line.line} did not close cleanly.`;
    } catch (error) {
      if (error instanceof LineCloseError && error.okSent) {
        line.answer = { saved: false, text: error.message };
      } else {
        line.outcome = 'failed';
        line.detail = messageOf(error);
      }
      stopped = `Not started: line ${line.line} failed.`;
    }
  }
};

/**
 * Reads the order back on a fresh page: leaves the page the lines were closed on, opens the
 * order again and exports its lines.
 */
const readOrderBack = async (
  adfWindow: AdfWindow,
  detail: RichResponse,
  searched: RichResponse,
  order: string,
  fields: Record<string, string>,
): Promise<ReadBack> => {
  const results = await closeDetailPage(adfWindow, detail, order);
  const reopened = await openRowDetail(adfWindow, [results, searched], order, fields);
  const lines = (await exportDetailTable(adfWindow, reopened, order)).map(mapPurchaseOrderLine);
  const readBack = {
    orderStatus: parseDetailFields(reopened).Status ?? null,
    statuses: new Map(lines.map(line => [Number(line.line), line.status])),
  };
  await closeDetailPage(adfWindow, reopened, order);
  return readBack;
};

/** Settles each attempted line's outcome from Fusion's answer and, when the order was read back, its status. */
const settle = (progress: LineProgress[], readBack: ReadBack | null, problem: string, action: CloseAction) =>
  progress.map(({ answer, ...line }): LineResult => {
    const statusAfter = readBack ? (readBack.statuses.get(line.line) ?? null) : line.status_before;
    if (!answer) return { ...line, status_after: statusAfter };

    if (!readBack) {
      return {
        ...line,
        outcome: answer.saved ? 'closed' : 'failed',
        detail: `${answer.text} The order could not be read back afterwards (${problem}).`,
        status_after: null,
      };
    }
    const closed = statusAfter === ACTIONS[action].status;
    return {
      ...line,
      outcome: closed ? 'closed' : 'failed',
      detail:
        answer.saved && !closed
          ? `${answer.text} Yet the line reads ${statusAfter ?? 'nothing'} afterwards.`
          : answer.text,
      status_after: statusAfter,
    };
  });

/**
 * Opens the order found by the search, checks each line, closes those that pass one at a
 * time, and reads the order back. Nothing after the first OK sent may throw: a failure
 * there would make the screen rerun the whole call in a new window.
 */
const closingLines: ResultsReader<CloseRun, CloseRequest> = {
  read: async ({ adfWindow, response, panel, report }, request) => {
    const { order } = request;
    if (!findRowLink(response, order)) throw ToolError.validation(`Oracle Fusion has no purchase order ${order}.`);

    report(`Opening ${order}`);
    const detail = await openRowDetail(adfWindow, [response], order, panel.values);
    const header = parseDetailFields(detail);
    if (header.Order !== order) {
      throw ToolError.internal(`Oracle Fusion opened order ${header.Order ?? 'unknown'} instead of ${order}.`);
    }
    const tableId = findOrderLinesTable(detail);
    if (!tableId) throw ToolError.internal(`The Oracle Fusion page for ${order} has no lines table.`);

    // The page first renders only some lines; selecting one has every line rendered.
    const firstKey = parseOrderLines(detail, tableId).lines[0]?.rowKey;
    const shown = firstKey
      ? parseRenderedOrderLines(await adfWindow.submit(selectLineEvent(tableId, firstKey)), tableId)
      : { lines: [], rowCount: 0 };
    if (shown.rowCount !== null && shown.lines.length < shown.rowCount) {
      throw ToolError.validation(
        `${order} has ${shown.rowCount} lines, but Oracle Fusion renders only ${shown.lines.length} at once.`,
      );
    }

    const byNumber = new Map(shown.lines.map(line => [line.line, line]));
    const orderStatus = header.Status ?? '';
    const progress: LineProgress[] = request.lines.map(wanted => {
      const found = byNumber.get(wanted.line);
      const refusal =
        orderStatus === 'Open' ? refusalFor(wanted, found, request.expected) : `The order is ${orderStatus}, not Open.`;
      return {
        line: wanted.line,
        item: wanted.item,
        outcome: refusal ? 'skipped' : 'not_attempted',
        detail: refusal ?? '',
        status_before: found?.status ?? null,
        status_after: null,
        answer: null,
      };
    });

    const toClose = progress.flatMap(line => {
      const found = byNumber.get(line.line);
      return line.outcome === 'not_attempted' && found ? [{ line, rowKey: found.rowKey }] : [];
    });
    if (toClose.length > 0) {
      const closeCommand = findCloseLineCommand(detail);
      if (!closeCommand) {
        throw ToolError.validation(`Oracle Fusion does not offer Close on the lines of ${order} to this account.`);
      }
      await closeEach(adfWindow, tableId, closeCommand, toClose, request, report);
    }

    const attempted = progress.some(line => line.answer !== null);
    if (!attempted) {
      await closeDetailPage(adfWindow, detail, order);
      return {
        orderStatus: orderStatus || null,
        verified: false,
        lines: progress.map(({ answer: _answer, ...line }) => ({ ...line, status_after: line.status_before })),
      };
    }

    report(`Reading ${order} back`);
    let readBack: ReadBack | null = null;
    let problem = '';
    try {
      readBack = await readOrderBack(adfWindow, detail, response, order, panel.values);
    } catch (error) {
      problem = messageOf(error);
    }
    return {
      orderStatus: readBack?.orderStatus ?? null,
      verified: readBack !== null,
      lines: settle(progress, readBack, problem, request.action),
    };
  },
};

const screen = createSearchScreen({
  workArea: purchaseOrdersWorkArea,
  workAreaSetting: PURCHASE_ORDERS_WORK_AREA_SETTING_LABEL,
  task: 'Manage Orders',
  results: closingLines,
});

/** What receiving still expects of each line of the order; nothing when receiving does not know the order. */
const expectedOf = async (order: string, report: StatusReporter): Promise<ExpectedQuantities> => {
  try {
    const rows = await expectedShipmentsScreen.search(expectedShipmentCriteria({ purchase_order: order }), report);
    return expectedQuantities(rows.map(mapExpectedShipment).filter(row => row.document_number === order));
  } catch (error) {
    if (error instanceof SearchRejectedError && unknownDocuments(error, ['purchase_order'])) return new Map();
    throw error;
  }
};

export const closePoLines = defineTool({
  name: 'close_po_lines',
  displayName: 'Close PO Lines',
  description:
    'Close lines of one purchase order, as Lines Actions → Close on the order page does, one line at a time ' +
    'with the action and reason given. A line is closed only when its number and item match, its status is ' +
    'Open and nothing on it has been received (Receive Expected Shipments still expects its full ordered ' +
    'quantity); any other line is skipped with the reason. The call stops at the first error, warning or ' +
    'unexpected dialog, leaving the remaining lines untouched, then reads the order back and returns each ' +
    'line’s status. close: closed for receiving and invoicing. close_for_receiving: no longer received. ' +
    'close_for_invoicing: no longer invoiced, but still received. A closed line can be reopened in Fusion. ' +
    `Receiving can take a few minutes to stop listing a closed line. At most ${MAX_LINES} lines per call. ` +
    'Runs in a background session.',
  summary: 'Close open, unreceived purchase order lines',
  icon: 'package-x',
  group: 'Purchasing',
  input: z.object({
    order: z.string().min(1).describe('Exact purchase order number (e.g., "ATL081-ZZZ09135")'),
    lines: z
      .array(
        z.object({
          line: z.number().int().positive().describe('Line number'),
          item: z.string().min(1).describe('Item number of the line; the line is skipped when it is another item'),
        }),
      )
      .min(1)
      .max(MAX_LINES)
      .describe(`Lines to close, each named by number and item (at most ${MAX_LINES})`),
    action: z
      .enum(['close', 'close_for_receiving', 'close_for_invoicing'])
      .describe('Close action, as listed in the Close Line dialog'),
    reason: z
      .string()
      .min(1)
      .max(MAX_REASON_LENGTH)
      .describe(`Reason saved with each closed line, exactly as written (up to ${MAX_REASON_LENGTH} characters)`),
  }),
  output: z.object({
    order: z.string().describe('Purchase order number'),
    order_status: z
      .string()
      .nullable()
      .describe('Status of the order at the end of the call; null when it could not be read back'),
    verified: z
      .boolean()
      .describe(
        'Whether the order was read back after a close was sent. When false after a close, each closed line ' +
          'rests on Fusion’s answer alone',
      ),
    lines: z
      .array(
        z.object({
          line: z.number().int().describe('Line number'),
          item: z.string().describe('Item number given for the line'),
          outcome: z
            .enum(['closed', 'skipped', 'failed', 'not_attempted'])
            .describe(
              'closed: the line now has the action’s status. skipped: the line did not pass the checks and was ' +
                'left alone. failed: Fusion refused or answered unexpectedly. not_attempted: the call stopped ' +
                'before this line',
            ),
          detail: z
            .string()
            .describe(
              'Fusion’s confirmation, the reason the line was skipped or not attempted, or Fusion’s exact error',
            ),
          status_before: z
            .string()
            .nullable()
            .describe('Line status before the call; null when the line is not on the order'),
          status_after: z
            .string()
            .nullable()
            .describe(
              'Line status at the end of the call: read back from Fusion after a close, otherwise the status ' +
                'before for a line left alone; null when unknown',
            ),
        }),
      )
      .describe('One entry per line asked for, in the order given'),
  }),
  handle: async (params, context) => {
    const report: StatusReporter = message => context?.reportProgress({ message });
    const deadline = Date.now() + CLOSING_BUDGET_MS;

    const numbers = params.lines.map(line => line.line);
    const repeated = numbers.filter((line, index) => numbers.indexOf(line) !== index);
    if (repeated.length > 0) throw ToolError.validation(`Line ${repeated[0]} is listed more than once.`);
    const reason = params.reason.trim();
    if (reason === '') throw ToolError.validation('Give a reason for closing the lines.');

    report('Checking what receiving still expects');
    const expected = await expectedOf(params.order, report);

    const run = await screen.search(purchaseOrderCriteria({ order: params.order }), report, {
      order: params.order,
      lines: params.lines,
      action: params.action,
      reason,
      expected,
      deadline,
    });
    return { order: params.order, order_status: run.orderStatus, verified: run.verified, lines: run.lines };
  },
});
