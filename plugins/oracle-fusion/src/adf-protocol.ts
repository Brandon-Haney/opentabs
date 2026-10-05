/**
 * Wire format of Oracle ADF Faces, the framework behind the classic Fusion pages.
 *
 * Every user action on an ADF page is a form POST naming the component that fired
 * (`event`), an XML payload describing what happened (`event.<id>`), and a server-side
 * view-state token. The server answers with an XML envelope whose `<fragment>` elements
 * carry replacement HTML and whose `<script>` elements carry client instructions,
 * including the messages a user would see in an error popup.
 *
 * Everything here is a pure function over request and response text.
 */

/** Value of one key in a rich-client event payload. `null` encodes a key sent without a value. */
type RichEventValue = string | number | boolean | null;

/** One event: its type and the other keys of its payload. */
type RichEventSpec = [type: string, props?: Record<string, RichEventValue>];

const EVENT_NAMESPACE = 'xmlns="http://oracle.com/richClient/comm"';

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const encodeEventValue = (key: string, value: RichEventValue): string => {
  if (value === null) return `<k v="${escapeXml(key)}"/>`;
  if (typeof value === 'boolean') return `<k v="${escapeXml(key)}"><b>${value ? 1 : 0}</b></k>`;
  if (typeof value === 'number') return `<k v="${escapeXml(key)}"><n>${value}</n></k>`;
  return `<k v="${escapeXml(key)}"><s>${escapeXml(value)}</s></k>`;
};

/** The keys of one event. `type` is written last, matching the order the ADF client uses. */
const encodeEventKeys = ([type, props = {}]: RichEventSpec): string =>
  Object.entries(props)
    .map(([key, value]) => encodeEventValue(key, value))
    .join('') + encodeEventValue('type', type);

/** Serializes a rich-client event payload. */
export const richEvent = (...event: RichEventSpec): string => `<m ${EVENT_NAMESPACE}>${encodeEventKeys(event)}</m>`;

/** Serializes several events fired at the same component in one request. */
export const richEventBatch = (events: RichEventSpec[]): string =>
  `<a ${EVENT_NAMESPACE} n="${events.length}">${events.map(event => `<m>${encodeEventKeys(event)}</m>`).join('')}</a>`;

/**
 * Rows a table claims it can display. The server renders at most this many rows per
 * response, so a large value returns a whole result at once instead of a scroll page.
 */
export const VIEWPORT_ROWS = 10_000;

/** Client state telling the server to render every row of a table in its next response. */
export const viewportDeltas = (tableId: string): string => `{${tableId}={viewportSize=${VIEWPORT_ROWS}}}`;

/** Identifiers the loopback page hands out for a window that is about to load. */
export interface WindowBootstrap {
  loopbackId: string;
  controlState: string;
}

/**
 * Reads the loopback page ADF serves before any real page. Its inline script carries the
 * loopback id and the control-state token the follow-up request must echo back. Returns
 * null when the text is some other page, such as a sign-in form.
 */
export const parseLoopback = (html: string): WindowBootstrap | null => {
  const loopbackId = html.match(/"_afrLoop",\s*"(\d+)"/)?.[1];
  const controlState = html.match(/'_adf\.ctrl-state':'([^']+)'/)?.[1];
  return loopbackId && controlState ? { loopbackId, controlState } : null;
};

/**
 * Query parameters of the request that follows the loopback page. `_afrWindowId=null`
 * asks the server for a window of its own, so the page state it creates is separate from
 * every window the user has open. The remaining parameters describe the display, which
 * ADF requires before it renders.
 */
export const windowQuery = (bootstrap: WindowBootstrap): Record<string, string | number> => ({
  _afrLoop: bootstrap.loopbackId,
  _afrWindowMode: 0,
  _afrWindowId: 'null',
  '_adf.ctrl-state': bootstrap.controlState,
  _afrFS: 16,
  _afrMT: 'screen',
  _afrMFW: 1280,
  _afrMFH: 800,
  _afrMFDW: 1280,
  _afrMFDH: 800,
  _afrMFC: 8,
  _afrMFCI: 0,
  _afrMFM: 0,
  _afrMFR: 96,
  _afrMFG: 0,
  _afrMFS: 0,
  _afrMFO: 0,
});

/** Where a window posts its events and the token identifying its server-side page state. */
export interface PageState {
  action: string;
  viewState: string;
}

const decodeAttribute = (value: string): string => value.replace(/&amp;/g, '&');

const VIEW_STATE_PATTERN = /name="javax\.faces\.ViewState" value="([^"]+)"/;

/** Reads the form action and view-state token from a fully rendered ADF page. */
export const parsePageState = (html: string): PageState | null => {
  const action = html.match(/<form id="f1"[^>]*\saction="([^"]+)"/)?.[1];
  const viewState = html.match(VIEW_STATE_PATTERN)?.[1];
  return action && viewState ? { action: decodeAttribute(action), viewState } : null;
};

/** Severity of a message the server attached to a response. */
type MessageSeverity = 'info' | 'confirmation' | 'warning' | 'error' | 'fatal';

/** A message the page would show the user, such as a validation failure. */
export interface AdfMessage {
  severity: MessageSeverity;
  /** Label of the field the message is about; empty for page-level messages. */
  field: string;
  text: string;
}

const JS_STRING = "'((?:[^'\\\\]|\\\\.)*)'";
const MESSAGE_PATTERN = new RegExp(
  `AdfPage\\.PAGE\\.addMessage\\((?:null|${JS_STRING}),\\s*new AdfFacesMessage\\(AdfFacesMessage\\.TYPE_(\\w+),` +
    `(?:null|${JS_STRING}),(?:null|${JS_STRING}),null\\)(?:,${JS_STRING})?\\)`,
  'g',
);

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t' };

/** Decodes the escapes ADF uses inside single-quoted JavaScript string literals. */
const unescapeJsString = (literal: string): string =>
  literal.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(.))/g, (_match, unicode, hex, char) => {
    if (unicode || hex) return String.fromCharCode(Number.parseInt(unicode ?? hex, 16));
    return SIMPLE_ESCAPES[char as string] ?? (char as string);
  });

const SEVERITIES: Record<string, MessageSeverity> = {
  INFO: 'info',
  CONFIRMATION: 'confirmation',
  WARNING: 'warning',
  ERROR: 'error',
  FATAL: 'fatal',
};

/** Reduces message text to plain text. Application messages arrive wrapped in an `<html>` element. */
const plainText = (text: string): string => (text.startsWith('<html>') ? text.replace(/<[^>]+>/g, '').trim() : text);

const parseMessages = (scripts: string): AdfMessage[] =>
  [...scripts.matchAll(MESSAGE_PATTERN)].map(match => {
    const [, , type, summary, detail, label] = match;
    return {
      severity: SEVERITIES[type ?? ''] ?? 'error',
      field: unescapeJsString(label ?? '').trim(),
      text: plainText(unescapeJsString(detail ?? summary ?? '')),
    };
  });

const stripCdata = (text: string): string => text.replace(/<!\[CDATA\[|\]\]>/g, '');

const collectElements = (envelope: string, tag: string): string =>
  [...envelope.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map(match => stripCdata(match[1] ?? ''))
    .join('\n');

/** A rich response that replaced part of the page. */
export interface RichResponse {
  /** Form action to use for the next request, when the response restated it. */
  action: string | null;
  /** View-state token to use for the next request, when the response restated it. */
  viewState: string | null;
  /** The replacement HTML of every fragment, parsed as one document. */
  document: Document;
  /** Source of every inline script, for reading values ADF only sends as client instructions. */
  scripts: string;
  messages: AdfMessage[];
}

/**
 * Parses the XML envelope answering a rich request. Returns null when the server did not
 * send page content — it answers with `<noop/>` or `<redirect>` once the window's page
 * state is gone, which the caller treats as a closed window.
 */
export const parseRichResponse = (envelope: string): RichResponse | null => {
  const action = envelope.match(/<content action="([^"]*)"/)?.[1];
  if (action === undefined) return null;

  const scripts = collectElements(envelope, 'script');
  return {
    action: action ? decodeAttribute(action) : null,
    viewState: envelope.match(VIEW_STATE_PATTERN)?.[1] ?? null,
    document: new DOMParser().parseFromString(collectElements(envelope, 'fragment'), 'text/html'),
    scripts,
    messages: parseMessages(scripts),
  };
};

/** Text of a rendered element with runs of whitespace, including non-breaking spaces, collapsed. */
export const elementText = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
