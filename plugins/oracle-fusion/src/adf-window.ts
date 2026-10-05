import { buildQueryString, fetchFromPage, fetchText, ToolError } from '@opentabs-dev/plugin-sdk';
import {
  type PageState,
  parseLoopback,
  parsePageState,
  parseRichResponse,
  type RichResponse,
  windowQuery,
} from './adf-protocol.js';

/** Entry point of the classic Fusion shell; every work area is reached from it. */
const HOME_PATH = '/fscmUI/faces/FuseWelcome';
const FORM_ID = 'f1';
const REQUEST_TIMEOUT_MS = 60_000;

/** One event fired at a component of the window's page. */
export interface RichEvent {
  /** Client id of the component the event fires on. */
  source: string;
  /** Payload built with `richEvent`. */
  payload: string;
  /** Form fields submitted alongside the event. */
  fields?: Record<string, string>;
  /** Component the server processes the event under; defaults to the source. */
  process?: string;
  /** Component the server re-renders in its answer. */
  render?: string;
  /** Client-side component state the server has not seen yet, in ADF's delta notation. */
  deltas?: string;
}

/**
 * A Fusion browser window that exists only on the server.
 *
 * ADF keeps the state of each page per window. This window is created with plain requests
 * and never rendered, so navigating and searching in it leaves the windows the user is
 * looking at untouched.
 */
export interface AdfWindow {
  /** HTML of the home page the window opened on. */
  readonly homeHtml: string;
  /** Fires an event and returns the part of the page the server re-rendered. */
  submit(event: RichEvent): Promise<RichResponse>;
  /** Fires an event whose answer is a file, and returns the file's text. */
  download(event: RichEvent, file: DownloadExpectation): Promise<string>;
}

/** What a download is expected to return and how long it may take. */
export interface DownloadExpectation {
  /**
   * Media type of the file. The server answers a download fired at a window it no longer
   * holds with an empty body or a page instead of the file, so any other type means the
   * window is closed.
   */
  contentType: string;
  /** Request timeout in milliseconds. */
  timeout: number;
}

/** Raised when the server no longer holds the window's page state. */
export class WindowClosedError extends Error {
  constructor() {
    super('The Oracle Fusion background window is no longer open on the server.');
    this.name = 'WindowClosedError';
  }
}

const eventFields = (event: RichEvent, state: PageState): Record<string, string | undefined> => ({
  ...event.fields,
  'org.apache.myfaces.trinidad.faces.FORM': FORM_ID,
  'javax.faces.ViewState': state.viewState,
  'oracle.adf.view.rich.RENDER': event.render,
  'oracle.adf.view.rich.DELTAS': event.deltas,
  event: event.source,
  [`event.${event.source}`]: event.payload,
  'oracle.adf.view.rich.PROCESS': event.process ?? event.source,
});

/**
 * Opens a window on the Fusion home page.
 *
 * ADF answers the first request for a page with a loopback script rather than the page;
 * the script's job is to call back with a window id. Asking for the id `null` makes the
 * server allocate a new window.
 */
export const openWindow = async (): Promise<AdfWindow> => {
  const bootstrap = parseLoopback(await fetchText(HOME_PATH));
  if (!bootstrap) {
    throw ToolError.auth('Oracle Fusion did not start a session — sign in to Fusion in this tab and try again.');
  }

  const homeHtml = await fetchText(`${HOME_PATH}?${buildQueryString(windowQuery(bootstrap))}`);
  const opened = parsePageState(homeHtml);
  if (!opened) throw ToolError.internal('Oracle Fusion returned a home page without a form to post events to.');

  let state = opened;

  const submit = async (event: RichEvent): Promise<RichResponse> => {
    const response = await fetchFromPage(state.action, {
      method: 'POST',
      headers: {
        'Adf-Rich-Message': 'true',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: buildQueryString(eventFields(event, state)),
      timeout: REQUEST_TIMEOUT_MS,
    });

    const parsed = parseRichResponse(await response.text());
    if (!parsed) throw new WindowClosedError();

    state = { action: parsed.action ?? state.action, viewState: parsed.viewState ?? state.viewState };
    return parsed;
  };

  const download = async (event: RichEvent, file: DownloadExpectation): Promise<string> => {
    const body = new FormData();
    for (const [name, value] of Object.entries(eventFields(event, state))) {
      if (value !== undefined) body.append(name, value);
    }

    const response = await fetchFromPage(state.action, { method: 'POST', body, timeout: file.timeout });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes(file.contentType)) throw new WindowClosedError();
    return response.text();
  };

  return { homeHtml, submit, download };
};
