import { ToolError } from '@opentabs-dev/plugin-sdk';
import type { AdfMessage, RichResponse } from './adf-protocol.js';
import { type AdfWindow, openWindow, WindowClosedError } from './adf-window.js';
import { clickEvent } from './detail-page.js';
import { parseFlatTable } from './flat-table.js';
import {
  advancedLookupEvent,
  closeLookupEvent,
  lookupPanelId,
  lookupTableId,
  lookupViewportDeltas,
  openLookupEvents,
} from './lookup.js';
import { findDialog } from './row-actions.js';
import {
  type Criterion,
  expandPanelEvent,
  leadingChangeEvent,
  parseQueryPanel,
  type QueryPanel,
  refreshQueryPanel,
  searchEvent,
  unappliedCriteria,
} from './search-page.js';
import { openTask, parseHomeTiles } from './work-area.js';

/** Receives a short status line at each stage of a search, repeated while a stage is still running. */
export type StatusReporter = (status: string) => void;

/** Value a query panel's operator submits to match text anywhere in a value. */
const CONTAINS_OPERATOR = 'CONTAINS';

/** A large search or export keeps the server busy for longer than a tool call may stay silent. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** What a results reader works from once a search has been accepted. */
export interface SearchResults {
  adfWindow: AdfWindow;
  /** The search page as it first opened, which holds the parts of the page a search does not re-render. */
  taskPage: RichResponse;
  /** The server's answer to the search. */
  response: RichResponse;
  /** The query panel as the search left it; its values travel with any further request. */
  panel: QueryPanel;
  report: StatusReporter;
}

/**
 * How a page's results are turned into data: by exporting a table, walking a tree, and so on.
 * `O` carries per-search choices from the tool, such as which rows to open.
 */
export interface ResultsReader<T, O = void> {
  /** Client state to send with the search itself, in ADF's delta notation. */
  searchDeltas?(taskPage: RichResponse, options: O): string | undefined;
  /**
   * Sets the results up once, when the search page opens in a new window, such as showing
   * columns the table hides by default.
   */
  prepare?(page: { adfWindow: AdfWindow; taskPage: RichResponse; panel: QueryPanel }): Promise<void>;
  read(results: SearchResults, options: O): Promise<T>;
}

/** Which search page a screen drives. */
export interface SearchScreenTarget<T, O = void> {
  /** Label of the home page tile that opens the work area; resolved per search so a changed setting applies. */
  workArea: () => string;
  /** Name of the plugin setting that overrides the tile label, quoted in the error raised when the tile is missing. */
  workAreaSetting: string;
  /**
   * Category of the Tasks panel that lists the task, such as Inventory or Receipts; omitted
   * for a work area whose Tasks panel does not group its tasks.
   */
  category?: string;
  /** Name of the task as listed in the work area's Tasks panel. */
  task: string;
  /** Title of the button that leads from the task's landing page to its search page, when it has one. */
  entryButton?: string;
  results: ResultsReader<T, O>;
}

/** Values a search field's lookup dialog found, as the dialog lists them. */
export interface LookupResults {
  /** Headings of the dialog's results table; the first names the field's own value. */
  headings: string[];
  /** Each match, its values in heading order. */
  rows: string[][];
}

/** A search field that has a lookup dialog. */
export interface LookupField {
  /** Label of the field on the search page. */
  label: string;
  /**
   * Label of the criterion in the field's lookup dialog that holds the field's value. It
   * can differ from the field's own label: the ASN field's dialog calls it "Shipment".
   */
  lookupLabel: string;
}

/** Runs searches on one Fusion search page. */
export interface SearchScreen<T, O = void> {
  search(criteria: Criterion[], report: StatusReporter, options: O): Promise<T>;
  /**
   * Finds the values a search field accepts that contain the given text, through the
   * field's lookup dialog. The field itself matches whole values only.
   */
  lookup(field: LookupField, text: string, report: StatusReporter): Promise<LookupResults>;
}

/** The search page, open in a background window. */
interface OpenScreen {
  adfWindow: AdfWindow;
  taskPage: RichResponse;
  panel: QueryPanel;
}

type Outcome<T> = { results: T } | { rejected: AdfMessage[] };

const describeMessage = (message: AdfMessage): string =>
  message.field ? `${message.field}: ${message.text}` : message.text;

/**
 * Raised when Fusion refuses a search or lookup, carrying the messages it gave. Each names
 * the field it is about when it is about one, so a tool can tell, for example, a value the
 * field does not know from any other refusal.
 */
export class SearchRejectedError extends ToolError {
  readonly messages: AdfMessage[];

  constructor(messages: AdfMessage[]) {
    super(`Oracle Fusion rejected the search — ${messages.map(describeMessage).join(' ')}`, 'VALIDATION_ERROR', {
      category: 'validation',
    });
    this.name = 'SearchRejectedError';
    this.messages = messages;
  }
}

const APPLICATION_ERROR = /An application error (?:has )?occurred/;

/**
 * Messages that mean a search did not return what was asked for. A warning counts: Fusion
 * uses one to say it cut a result short.
 *
 * Fusion answers with a generic application error, rather than a closed-window response,
 * when it has discarded part of a window's page state; the same search succeeds in a new
 * window, so that error is raised as a closed window.
 */
const refusedBy = (response: RichResponse): AdfMessage[] => {
  const refused = response.messages.filter(
    message => message.severity !== 'info' && message.severity !== 'confirmation',
  );
  if (refused.some(message => APPLICATION_ERROR.test(message.text))) throw new WindowClosedError();
  return refused;
};

const enterSearchPage = async <T, O>(
  adfWindow: AdfWindow,
  landingPage: RichResponse,
  target: SearchScreenTarget<T, O>,
): Promise<RichResponse> => {
  const button = landingPage.document.querySelector(`[id][title="${target.entryButton}"]`);
  if (!button) {
    throw ToolError.internal(`The Oracle Fusion task "${target.task}" has no "${target.entryButton}" button.`);
  }
  return adfWindow.submit(clickEvent(button.id));
};

const openScreen = async <T, O>(target: SearchScreenTarget<T, O>): Promise<OpenScreen> => {
  const adfWindow = await openWindow();

  const label = target.workArea();
  const tiles = parseHomeTiles(adfWindow.homeHtml);
  const tile = tiles.find(candidate => candidate.label.trim().toLowerCase() === label.trim().toLowerCase());
  if (!tile) {
    throw ToolError.validation(
      `The Oracle Fusion home page has no tile labelled "${label}". Tiles shown to this user: ` +
        `${tiles.map(candidate => candidate.label).join(', ') || 'none'}. If your organization renamed the ` +
        `work area, set the plugin's "${target.workAreaSetting}" setting to the tile's label.`,
    );
  }

  const landingPage = await openTask(adfWindow, tile, target.category, target.task);
  const taskPage = target.entryButton ? await enterSearchPage(adfWindow, landingPage, target) : landingPage;
  const panel = parseQueryPanel(taskPage);
  if (!panel) throw ToolError.internal(`The Oracle Fusion task "${target.task}" did not open as a search page.`);
  await target.results.prepare?.({ adfWindow, taskPage, panel });
  return { adfWindow, taskPage, panel };
};

/**
 * Creates the driver for one search page.
 *
 * The page lives in a single background window that is opened on first use and kept for
 * later searches. ADF keeps a bounded number of page states per session and discards the
 * oldest beyond that, so opening a window per search would eventually expire the pages the
 * user has open. Searches run one at a time because each request depends on the page state
 * the previous one left behind.
 */
export const createSearchScreen = <T, O = void>(target: SearchScreenTarget<T, O>): SearchScreen<T, O> => {
  let screen: OpenScreen | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /** The search page with its query panel unfolded, opening the window first when there is none. */
  const readyScreen = async (report: StatusReporter): Promise<OpenScreen> => {
    if (!screen) {
      report(`Opening ${target.task}`);
      screen = await openScreen(target);
    }

    // The panel folds away after a successful search, and a folded panel silently ignores
    // submitted criteria and re-runs the previous search. It has to be unfolded first.
    if (screen.panel.collapsed) {
      const unfolded = parseQueryPanel(await screen.adfWindow.submit(expandPanelEvent(screen.panel)), screen.panel.id);
      if (!unfolded) throw ToolError.internal(`The Oracle Fusion task "${target.task}" lost its search panel.`);
      screen.panel = unfolded;
    }
    return screen;
  };

  /**
   * Commits each leading criterion on its own, in order, submitting `otherFields` alongside.
   * Returns the page's refusal of one, or the panel with every leading criterion applied.
   */
  const commitLeading = async (
    adfWindow: AdfWindow,
    start: QueryPanel,
    criteria: Criterion[],
    otherFields: Record<string, string> = {},
  ): Promise<{ panel: QueryPanel } | { rejected: AdfMessage[] }> => {
    let panel = start;
    for (const criterion of criteria) {
      const change = leadingChangeEvent(panel, criterion);
      if (!change) continue;
      const changed = await adfWindow.submit({ ...change, fields: { ...otherFields, ...change.fields } });
      const refused = refusedBy(changed);
      if (refused.length > 0) return { rejected: refused };
      panel = refreshQueryPanel(panel, changed);
    }
    return { panel };
  };

  const searchOnce = async (criteria: Criterion[], report: StatusReporter, options: O): Promise<Outcome<T>> => {
    const open = await readyScreen(report);
    const { adfWindow, taskPage } = open;

    const committed = await commitLeading(adfWindow, open.panel, criteria);
    if ('rejected' in committed) return committed;
    open.panel = committed.panel;

    report('Searching');
    const panel = open.panel;
    const query = searchEvent(panel, criteria);
    const response = await adfWindow.submit({ ...query, deltas: target.results.searchDeltas?.(taskPage, options) });
    open.panel = parseQueryPanel(response, panel.id) ?? panel;

    // A rejected search leaves the previous results on the page, so reading them would
    // return rows that do not match the criteria.
    const rejected = refusedBy(response);
    if (rejected.length > 0) return { rejected };

    const unapplied = unappliedCriteria(query, open.panel, criteria);
    if (unapplied.length > 0) {
      throw ToolError.internal(
        `Oracle Fusion ran the search without applying ${unapplied
          .map(({ label, sent, shown }) => `${label} (sent "${sent}", the page kept "${shown}")`)
          .join(', ')}, so its results do not match the criteria and were not read.`,
      );
    }

    return {
      results: await target.results.read({ adfWindow, taskPage, response, panel: open.panel, report }, options),
    };
  };

  const lookupOnce = async (
    { label, lookupLabel }: LookupField,
    text: string,
    report: StatusReporter,
  ): Promise<Outcome<LookupResults>> => {
    const { adfWindow, panel } = await readyScreen(report);
    const field = panel.fieldsByLabel.get(label);
    if (!field) throw ToolError.internal(`The Oracle Fusion search panel has no "${label}" field.`);

    report(`Looking up ${label}`);
    let opened: RichResponse | null = null;
    for (const event of openLookupEvents(field, panel.values)) opened = await adfWindow.submit(event);
    if (!opened || !findDialog(opened)) {
      throw ToolError.internal(`The Oracle Fusion field "${label}" did not open a lookup dialog.`);
    }
    const advanced = await adfWindow.submit(advancedLookupEvent(field, panel.values));
    const lookupPanel = parseQueryPanel(advanced, lookupPanelId(field));
    if (!lookupPanel) throw ToolError.internal(`The Oracle Fusion lookup for "${label}" has no search panel.`);

    // The field's value is matched by containment.
    const criteria: Criterion[] = [
      { label: `${lookupLabel} Operator`, text: CONTAINS_OPERATOR, leading: true },
      { label: lookupLabel, text },
    ];
    const committed = await commitLeading(adfWindow, lookupPanel, criteria, panel.values);
    if ('rejected' in committed) return committed;

    const query = searchEvent(committed.panel, criteria);
    const answer = await adfWindow.submit({
      ...query,
      fields: { ...panel.values, ...query.fields },
      deltas: lookupViewportDeltas(field),
    });
    const rejected = refusedBy(answer);
    if (rejected.length > 0) return { rejected };

    const table = parseFlatTable(answer, lookupTableId(field));
    await adfWindow.submit(closeLookupEvent(field, { ...panel.values, ...committed.panel.values }));
    if (table.rowCount !== null && table.rows.length !== table.rowCount) {
      throw ToolError.internal(
        `The Oracle Fusion lookup for "${label}" holds ${table.rowCount} matches but returned ${table.rows.length}.`,
      );
    }
    return { results: { headings: table.headings, rows: table.rows } };
  };

  /** Runs one operation on the page, reopening the window once if the server has dropped it. */
  const withWindow = async <R>(operation: () => Promise<Outcome<R>>): Promise<Outcome<R>> => {
    try {
      return await operation();
    } catch (error) {
      // After a failure the page state on the server is unknown, so the window is abandoned.
      screen = null;
      if (!(error instanceof WindowClosedError)) throw error;
    }

    try {
      return await operation();
    } catch (error) {
      screen = null;
      if (!(error instanceof WindowClosedError)) throw error;
      throw ToolError.internal('Oracle Fusion closed the background window twice in a row — reload the Fusion tab.');
    }
  };

  /**
   * Queues an operation behind the ones already running, repeating its current stage every
   * few seconds so a long operation is not taken for a stalled one.
   */
  const run = async <R>(
    operation: (report: StatusReporter) => Promise<Outcome<R>>,
    report: StatusReporter,
  ): Promise<R> => {
    let status = 'Waiting for the previous search';
    const reportStage: StatusReporter = stage => {
      status = stage;
      report(stage);
    };
    const heartbeat = setInterval(() => report(status), HEARTBEAT_INTERVAL_MS);

    const outcome = queue.then(() => withWindow(() => operation(reportStage))).finally(() => clearInterval(heartbeat));
    queue = outcome.catch(() => undefined);

    const result = await outcome;
    if ('rejected' in result) throw new SearchRejectedError(result.rejected);
    return result.results;
  };

  return {
    search: (criteria, report, options) => run(stage => searchOnce(criteria, stage, options), report),
    lookup: (field, text, report) => run(stage => lookupOnce(field, text, stage), report),
  };
};
