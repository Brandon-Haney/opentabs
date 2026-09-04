// ---------------------------------------------------------------------------
// Microsoft upstream failures — front-door headers, request ids, and the
// ToolErrors a Microsoft request throws once fetchWithRetry has given up
//
// Microsoft-specific and plugin-side by design: the x-proxyerror* headers, the
// request-id header precedence and the `{ error: { code, message } }` envelope
// are conventions of Microsoft's service front door, Graph, Outlook REST and
// OWS, not of the platform. The generic retry loop is the SDK's fetchWithRetry;
// this module supplies its `isTransient` predicate, counts its attempts and
// classifies the failure it gives up on.
// ---------------------------------------------------------------------------

import {
  type FetchWithRetryOptions,
  parseRetryAfterMs,
  ToolError,
  type ToolErrorDetails,
} from '@opentabs-dev/plugin-sdk';

/**
 * Suffix of the `x-proxyerrorlabel` value Microsoft's service front door (the
 * M365 routing plane) sets when it fails while still forwarding the request,
 * e.g. `Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest`.
 * Only this stage proves the request never reached the mailbox or workbook; a
 * label from any later stage may follow a request that already executed.
 */
export const FRONT_DOOR_REQUEST_STAGE_SUFFIX = '::OnHttpRequest';

/** `retryAfterMs` attached to UPSTREAM_UNAVAILABLE when the last response carried no Retry-After header. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/** Longest upstream `error.message` quoted inside an UPSTREAM_UNAVAILABLE message. */
const MAX_ENVELOPE_MESSAGE_CHARS = 200;

/** Response headers that carry an upstream correlation id, in precedence order. */
const REQUEST_ID_HEADERS = ['request-id', 'x-ms-request-id', 'client-request-id'] as const;

/**
 * Prefix of the message fetchWithRetry gives an exhausted network failure. The
 * underlying TypeError message travels only in that text, after this prefix;
 * the attempt count is never read from it (see createAttemptTracker).
 */
const FETCH_WITH_RETRY_NETWORK_PREFIX = /^fetchWithRetry: network error reaching \S+ after \d+ attempts?: /;

export interface FrontDoorError {
  /** `x-proxyerrorlabel` — the failing component and stage. */
  label: string;
  /** `x-proxyerrormessage`, e.g. "The network is busy.". */
  message: string | null;
  /** `x-proxyerrorhresult`, e.g. "0x80070036". */
  hresult: string | null;
}

/** Context every upstream error message carries: the host (never the path) and how many attempts were made. */
export interface UpstreamAttemptContext {
  host: string;
  attempts: number;
}

/** Counts the attempts one fetchWithRetry call makes, observed through its `onRetry` callback. */
export interface AttemptTracker {
  /** Pass as the `onRetry` option of the fetchWithRetry call being tracked. */
  onRetry: NonNullable<FetchWithRetryOptions['onRetry']>;
  /** Attempts made so far: the initial request plus one per retry observed. */
  attempts(): number;
}

/**
 * Creates a tracker for a single fetchWithRetry call. fetchWithRetry announces
 * every retry through `onRetry` right before its backoff sleep, so once the
 * call has settled `attempts()` is exactly the number of requests it sent —
 * including the cases where it stopped early because the deadline fell inside
 * the next delay or a Retry-After exceeded what it waits for. Callers pass the
 * count to upstreamUnavailableError and recodeFetchFailure rather than deriving
 * it from the retry policy.
 */
export const createAttemptTracker = (): AttemptTracker => {
  let retries = 0;
  return {
    onRetry: () => {
      retries += 1;
    },
    attempts: () => retries + 1,
  };
};

/**
 * Reads the front-door error headers. Null when `x-proxyerrorlabel` is absent —
 * including on a cross-origin response whose CORS policy does not expose the
 * header (same-origin OWS responses always expose it).
 */
export const readFrontDoorError = (response: Response): FrontDoorError | null => {
  const label = response.headers.get('x-proxyerrorlabel');
  if (label === null || label === '') return null;
  return {
    label,
    message: response.headers.get('x-proxyerrormessage'),
    hresult: response.headers.get('x-proxyerrorhresult'),
  };
};

/**
 * True when the front door refused the request before forwarding it (the label
 * ends with FRONT_DOOR_REQUEST_STAGE_SUFFIX). This is the `isTransient`
 * predicate for fetchWithRetry: it vouches that the request never executed at
 * the origin, so even a POST, PUT or DELETE may be replayed.
 */
export const isFrontDoorRefusal = (response: Response): boolean =>
  readFrontDoorError(response)?.label.endsWith(FRONT_DOOR_REQUEST_STAGE_SUFFIX) === true;

/** First non-empty request id header in REQUEST_ID_HEADERS order; null when none is exposed. */
export const readUpstreamRequestId = (headers: Headers): string | null => {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value !== '') return value;
  }
  return null;
};

interface UpstreamErrorEnvelope {
  code: string | null;
  message: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const nonEmptyString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Reads the `{ error: { code, message } }` envelope Graph, Outlook REST and OWS
 * return with a JSON content type. Null when the body is not JSON, is already
 * consumed, does not parse, or carries neither field.
 */
const readErrorEnvelope = async (response: Response): Promise<UpstreamErrorEnvelope | null> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (response.bodyUsed || !contentType.includes('application/json')) return null;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
  const code = nonEmptyString(parsed.error.code);
  const message = nonEmptyString(parsed.error.message);
  return code === null && message === null ? null : { code, message };
};

const truncate = (text: string): string =>
  text.length > MAX_ENVELOPE_MESSAGE_CHARS ? `${text.slice(0, MAX_ENVELOPE_MESSAGE_CHARS - 1)}…` : text;

const attemptsText = (attempts: number): string => `${attempts} attempt${attempts === 1 ? '' : 's'}`;

/**
 * Builds the UPSTREAM_UNAVAILABLE ToolError for the last response fetchWithRetry
 * returned after a transient failure: `category: 'internal'`, `retryable: true`,
 * `retryAfterMs` from the Retry-After header when present (else
 * DEFAULT_RETRY_AFTER_MS). The message names Microsoft's service front door
 * when a front-door label is present, and always carries the host, the HTTP
 * status, the attempt count, the JSON error envelope when the body is JSON,
 * and `request-id <id>` when the upstream exposed one. `details` carries the
 * same facts for the audit log: `httpStatus`, `attempts`, `requestId` when
 * exposed and `frontDoorLabel` when present. Reads the response body when it
 * is JSON — callers must pass the response unconsumed.
 */
export const upstreamUnavailableError = async (
  response: Response,
  { host, attempts }: UpstreamAttemptContext,
): Promise<ToolError> => {
  const frontDoor = readFrontDoorError(response);
  const envelope = await readErrorEnvelope(response);
  const requestId = readUpstreamRequestId(response.headers);
  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfterMs =
    (retryAfterHeader === null ? undefined : parseRetryAfterMs(retryAfterHeader)) ?? DEFAULT_RETRY_AFTER_MS;

  const envelopeText = envelope
    ? ` (${[envelope.code, envelope.message === null ? null : truncate(envelope.message)].filter(part => part !== null).join(': ')})`
    : '';
  const requestIdText = requestId === null ? '' : `; request-id ${requestId}`;
  const message = frontDoor
    ? `Microsoft's service front door failed the request to ${host} with HTTP ${response.status}${frontDoor.message === null ? '' : ` "${frontDoor.message}"`}${envelopeText} after ${attemptsText(attempts)}${requestIdText}.`
    : `${host} returned HTTP ${response.status}${envelopeText} after ${attemptsText(attempts)}${requestIdText}.`;

  const details: ToolErrorDetails = { httpStatus: response.status, attempts };
  if (requestId !== null) details.requestId = requestId;
  if (frontDoor) details.frontDoorLabel = frontDoor.label;
  return new ToolError(message, 'UPSTREAM_UNAVAILABLE', {
    category: 'internal',
    retryable: true,
    retryAfterMs,
  }).withDetails(details);
};

/**
 * Recodes the ToolErrors fetchWithRetry throws into this plugin's upstream
 * vocabulary: an exhausted network failure becomes NETWORK_ERROR
 * (`category: 'internal'`, `retryable: true`, message
 * `Network error reaching <host> after N attempts: <TypeError message>` and
 * `details: { attempts }`, with `attempts` the count observed by an
 * AttemptTracker) and a caller abort becomes ABORTED. Every other value — a
 * TimeoutError DOMException from `AbortSignal.timeout`, a ToolError raised by
 * the caller's own status classification — is returned unchanged, so callers
 * `throw` the result.
 */
export const recodeFetchFailure = (error: unknown, host: string, attempts: number): unknown => {
  if (!(error instanceof ToolError)) return error;
  if (error.code === 'aborted') return new ToolError(`Request to ${host} aborted.`, 'ABORTED');
  if (error.code !== 'network_error') return error;
  const cause = error.message.replace(FETCH_WITH_RETRY_NETWORK_PREFIX, '');
  return new ToolError(`Network error reaching ${host} after ${attemptsText(attempts)}: ${cause}`, 'NETWORK_ERROR', {
    category: 'internal',
    retryable: true,
  }).withDetails({ attempts });
};
