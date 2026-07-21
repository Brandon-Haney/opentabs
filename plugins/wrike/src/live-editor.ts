import { ToolError } from '@opentabs-dev/plugin-sdk';
import { getAccountId, getCurrentUserId } from './wrike-api.js';

// Wrike task descriptions are a collaborative rich-text document, not a plain
// task field. The web app edits them over a real-time WebSocket
// (`rta2.www.wrike.com/bullet`, routing key `live_editor`) using the Etherpad
// Easysync changeset format, authenticated by the same session cookie as the
// /ui RPC layer — so the adapter can drive it directly. There is no HTTP write
// path; this module replays that protocol to set a description.
//
// Input is Markdown. Inline formatting is encoded via the changeset attribute
// pool: bold, italic, underline, strikethrough, inline code, and links. Block
// formatting (headings, lists, code blocks) is not yet encoded.

const RTA_HOST = 'rta2.www.wrike.com';
const CLIENT_VERSION = 'app:ts_wrike_host_app;ver:2.68.4-40543706';
/** Overall budget for the connect → ready → submit → accept round-trip. */
const ROUND_TRIP_TIMEOUT_MS = 20_000;

// --- Etherpad Easysync changeset encoding ---

const base36 = (n: number): string => n.toString(36);

/** A changeset attribute: a [key, value] pair stored in the changeset pool. */
type Attribute = [string, string | boolean];

/** A run of text (containing no newlines) carrying a set of inline attributes. */
interface Segment {
  text: string;
  attributes: Attribute[];
}

/** An attribute run from a line's `a` op string: `markers` are indices into the document's pool. */
interface AttributeRun {
  markers: number[];
  len: number;
  /** Whether the run ends in a newline (encoded with `|` in the op string). */
  newline: boolean;
}

/** Read a base-36 integer from `text` starting at `from`, returning the value and the index after it. */
const readBase36 = (text: string, from: number): { value: number; end: number } => {
  let end = from;
  while (end < text.length && /[0-9a-z]/i.test(text[end] ?? '')) end++;
  return { value: Number.parseInt(text.slice(from, end), 36), end };
};

/**
 * Parse a line's `a` attribute op string (e.g. `*0+5+1*1+5|1+1`) into ordered
 * runs over its text. `*N` markers reference the document pool; `+N` is an
 * unattributed/attributed run of N chars; `|L+N` is a run of N chars ending in
 * a newline.
 */
const parseAttributeRuns = (a: string): AttributeRun[] => {
  const runs: AttributeRun[] = [];
  let markers: number[] = [];
  let i = 0;
  while (i < a.length) {
    const ch = a[i];
    if (ch === '*') {
      const { value, end } = readBase36(a, i + 1);
      markers.push(value);
      i = end;
    } else if (ch === '|') {
      const lineCount = readBase36(a, i + 1); // line count; the op char ('+') follows
      const length = readBase36(a, lineCount.end + 1);
      runs.push({ markers, len: length.value, newline: true });
      markers = [];
      i = length.end;
    } else if (ch === '+') {
      const { value, end } = readBase36(a, i + 1);
      runs.push({ markers, len: value, newline: false });
      markers = [];
      i = end;
    } else {
      i++;
    }
  }
  return runs;
};

/**
 * Build the removal ops for the whole document body, keeping the mandatory
 * final newline and reproducing each run's attributes — Wrike rejects a removal
 * whose composition does not match the original text's attributes. `mapAttr`
 * resolves an attribute (from the old document pool) into the new changeset pool.
 */
const buildRemoval = (
  lines: { a?: string; s?: string }[],
  oldPool: Attribute[],
  mapAttr: (attribute: Attribute) => number,
): string => {
  const runs = lines.flatMap(line => parseAttributeRuns(line.a ?? ''));
  let ops = '';
  runs.forEach((run, index) => {
    const markers = run.markers
      .map(poolIdx => oldPool[poolIdx])
      .filter((attribute): attribute is Attribute => attribute !== undefined)
      .map(attribute => `*${base36(mapAttr(attribute))}`)
      .join('');
    if (index === runs.length - 1) {
      // Keep the document's final newline; remove only the rest of this run.
      const removeLen = run.len - 1;
      if (removeLen > 0) ops += `${markers}-${base36(removeLen)}`;
    } else if (run.newline) {
      ops += `${markers}|1-${base36(run.len)}`;
    } else {
      ops += `${markers}-${base36(run.len)}`;
    }
  });
  return ops;
};

// --- Markdown parsing ---

/**
 * Parse a single line of Markdown into attributed segments. Supports
 * `**bold**`/`__bold__`, `*italic*`/`_italic_`, `~~strike~~`, `` `code` ``,
 * `[label](url)`, and `<u>underline</u>`. Unmatched delimiters are left as
 * literal text. The input must not contain newlines.
 */
const parseInlineMarkdown = (line: string): Segment[] => {
  const segments: Segment[] = [];
  const active = new Map<string, Attribute>();
  let buffer = '';

  const flush = (): void => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer, attributes: [...active.values()] });
    buffer = '';
  };
  const toggle = (key: string, value: boolean | string): void => {
    if (active.has(key)) active.delete(key);
    else active.set(key, [key, value]);
  };

  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const two = line.slice(i, i + 2);
    const ch = line[i];

    // Inline code: literal content until the next backtick, no further parsing.
    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i) {
        flush();
        segments.push({ text: line.slice(i + 1, end), attributes: [['code', true], ...active.values()] });
        i = end + 1;
        continue;
      }
    }
    // Link: [label](url). The label is parsed for inline formatting.
    if (ch === '[') {
      const close = line.indexOf('](', i + 1);
      if (close > i) {
        const urlEnd = line.indexOf(')', close + 2);
        if (urlEnd > close) {
          const url = line.slice(close + 2, urlEnd);
          flush();
          for (const segment of parseInlineMarkdown(line.slice(i + 1, close))) {
            segments.push({ text: segment.text, attributes: [...segment.attributes, ['link', url]] });
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }
    if (rest.startsWith('<u>')) {
      flush();
      active.set('underline', ['underline', true]);
      i += 3;
      continue;
    }
    if (rest.startsWith('</u>')) {
      flush();
      active.delete('underline');
      i += 4;
      continue;
    }
    if (two === '**' || two === '__') {
      flush();
      toggle('bold', true);
      i += 2;
      continue;
    }
    if (two === '~~') {
      flush();
      toggle('strike', true);
      i += 2;
      continue;
    }
    if (ch === '*' || ch === '_') {
      flush();
      toggle('italic', true);
      i += 1;
      continue;
    }

    buffer += ch;
    i++;
  }
  flush();
  return segments;
};

/** Parse Markdown into lines of attributed segments (CRLF normalised, trailing blank lines trimmed). */
const parseMarkdown = (markdown: string): Segment[][] =>
  markdown.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(parseInlineMarkdown);

/**
 * Build the changeset (and its attribute pool) that replaces the whole
 * description with `lines`. The old body is removed — the document's mandatory
 * final newline is kept implicitly — and the new attributed content inserted.
 * The charbank holds removed-then-inserted text in op order; inline attributes
 * are applied to insert ops with `*<poolIndex>` markers.
 */
export const buildFormattedChangeset = (
  oldDoc: { lines: { a?: string; s?: string }[]; pool: Attribute[] },
  lines: Segment[][],
): { op: string; pool: Attribute[] } => {
  const oldText = oldDoc.lines.map(line => line.s ?? '').join('');
  const oldLen = oldText.length;
  const removedText = oldText.slice(0, Math.max(0, oldLen - 1));

  const pool: Attribute[] = [];
  const poolIndex = (attribute: Attribute): number => {
    const found = pool.findIndex(([key, value]) => key === attribute[0] && value === attribute[1]);
    if (found >= 0) return found;
    pool.push(attribute);
    return pool.length - 1;
  };

  const removeOps = buildRemoval(oldDoc.lines, oldDoc.pool, poolIndex);

  let insertOps = '';
  let insertedText = '';
  lines.forEach((segments, lineIndex) => {
    for (const segment of segments) {
      if (segment.text.length === 0) continue;
      const markers = segment.attributes.map(attribute => `*${base36(poolIndex(attribute))}`).join('');
      insertOps += `${markers}+${base36(segment.text.length)}`;
      insertedText += segment.text;
    }
    // Lines are joined by newlines; the final line is terminated by the kept
    // document newline, so no trailing `|1+1` is emitted for it.
    if (lineIndex < lines.length - 1) {
      insertOps += '|1+1';
      insertedText += '\n';
    }
  });

  const newLen = insertedText.length + 1;
  const delta = newLen - oldLen;
  const sign = delta >= 0 ? '>' : '<';
  const header = `X:${base36(oldLen)}${sign}${base36(Math.abs(delta))}`;
  const op = `${header}${removeOps}${insertOps}$${removedText}${insertedText}`;
  return { op, pool };
};

// --- Live-editor WebSocket protocol ---

interface LiveEditorLine {
  /** Attribute op string describing this line's formatting runs. */
  a?: string;
  s?: string;
}

interface LiveEditorMessage {
  id?: number;
  routing_key?: string;
  payload?: {
    type?: string;
    t?: string;
    task_id?: string;
    v?: number;
    d?: { lines?: LiveEditorLine[]; pool?: Attribute[] };
  };
}

const randomInstanceId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `web-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * Set a task's description (Markdown input) by replaying the live-editor
 * protocol:
 *   1. open the bullet WebSocket (cookie-authenticated),
 *   2. on `new_session`, send `ready` to open the document,
 *   3. when the server returns the current document + version, build a changeset
 *      and `submit` it at that version,
 *   4. resolve on `accept`.
 */
export const setTaskDescription = (taskId: number, markdown: string): Promise<void> => {
  const accountId = getAccountId();
  const userId = getCurrentUserId();
  if (!accountId || !userId) throw ToolError.auth('Not authenticated — please log in to Wrike.');

  const lines = parseMarkdown(markdown);
  const taskIdStr = String(taskId);
  const params = new URLSearchParams({
    account_id: accountId,
    instance_id: randomInstanceId(),
    user_id: userId,
    auth_handler: 'backend',
    client_version: CLIENT_VERSION,
    route_id: '20',
  });
  const url = `wss://${RTA_HOST}/bullet?${params.toString()}`;

  return new Promise<void>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      reject(
        ToolError.internal(`Could not open Wrike live-editor socket: ${err instanceof Error ? err.message : err}`),
      );
      return;
    }

    let settled = false;
    let readySent = false;
    let submitted = false;

    const timer = setTimeout(
      () => fail(ToolError.timeout('Timed out updating the description.')),
      ROUND_TRIP_TIMEOUT_MS,
    );

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    };
    const fail = (error: ToolError): void => {
      if (settled) return;
      finish();
      reject(error);
    };
    const succeed = (): void => {
      if (settled) return;
      finish();
      resolve();
    };

    const send = (message: unknown): void => socket.send(JSON.stringify(message));

    const sendReady = (): void => {
      if (readySent) return;
      readySent = true;
      send({
        routing_key: 'live_editor',
        payload: { task_id: taskIdStr, t: 'ready', account_id: Number(accountId), token: userId },
        id: 1,
      });
    };

    const submit = (message: LiveEditorMessage): void => {
      if (submitted) return;
      const version = message.payload?.v;
      if (typeof version !== 'number') {
        fail(ToolError.internal('Wrike did not return a document version for the description.'));
        return;
      }
      const oldDoc = { lines: message.payload?.d?.lines ?? [], pool: message.payload?.d?.pool ?? [] };
      const { op, pool } = buildFormattedChangeset(oldDoc, lines);
      submitted = true;
      send({
        routing_key: 'live_editor',
        payload: { task_id: taskIdStr, t: 'submit', v: version, c: { op, p: pool }, s: [0, 0] },
        id: 2,
      });
    };

    const handleMessage = (message: LiveEditorMessage): void => {
      if (message.payload?.type === 'new_session') {
        sendReady();
        return;
      }
      if (message.routing_key !== 'live_editor' || message.payload?.task_id !== taskIdStr) return;
      if (message.payload.t === 'task') submit(message);
      else if (message.payload.t === 'accept' && submitted) succeed();
    };

    socket.onmessage = (event: MessageEvent): void => {
      if (typeof event.data !== 'string') return;
      let parsed: { messages?: LiveEditorMessage[] };
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return; // non-JSON frames (e.g. "pong") carry no protocol state
      }
      const messages = parsed.messages;
      if (!Array.isArray(messages)) return;

      let maxId = 0;
      for (const message of messages) {
        if (typeof message.id === 'number' && message.id > maxId) maxId = message.id;
        handleMessage(message);
      }
      // Acknowledge the batch so the server does not redeliver.
      if (maxId > 0 && !settled) send({ ack: maxId });
    };

    socket.onerror = (): void => fail(ToolError.internal('Wrike live-editor socket error.'));
    socket.onclose = (): void => {
      if (!settled) fail(ToolError.internal('Wrike closed the live-editor socket before the description was saved.'));
    };
  });
};
