/**
 * Minimal ZIP parser/writer and OOXML utilities for PPTX manipulation in the browser.
 *
 * PPTX files are ZIP archives containing OOXML (XML) files. This module provides:
 * - ZIP reading: parse a ZIP blob into a map of filename→Uint8Array entries
 * - ZIP writing: pack a map of filename→Uint8Array entries back into a ZIP blob
 * - OOXML helpers: extract text from slides, modify slide XML, add/remove slides
 */

import { ToolError } from '@opentabs-dev/plugin-sdk';
import { GRAPH_BASE, requireAuth } from './powerpoint-api.js';
import {
  deleteSession,
  listSessions,
  type PresentationSession,
  peekSession,
  storeSession,
  touchSession,
} from './session.js';

// --- ZIP constants ---
const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

// --- Helpers ---

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

const getLocalName = (node: Node): string | undefined => (isElement(node) ? node.localName : undefined);

const collectStreamChunks = async (readable: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const reader = readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (value) chunks.push(value);
    if (done) break;
  }
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    result.set(c, pos);
    pos += c.length;
  }
  return result;
};

// --- ZIP reader ---

/** Parse a ZIP file into entries. */
export const readZip = async (blob: Blob): Promise<Map<string, Uint8Array>> => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer as ArrayBuffer);
  const entries = new Map<string, Uint8Array>();

  // Find End of Central Directory record (search backwards from end)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIR_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw ToolError.internal('Invalid ZIP: no EOCD record');

  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);

  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_HEADER_SIG)
      throw ToolError.internal('Invalid ZIP: bad central directory header');

    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const name = new TextDecoder().decode(buf.subarray(offset + 46, offset + 46 + nameLen));

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawData = buf.slice(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      entries.set(name, new Uint8Array(rawData));
    } else if (compressionMethod === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      void writer.write(rawData).then(() => writer.close());
      const decompressed = await collectStreamChunks(ds.readable);
      const result = new Uint8Array(uncompressedSize);
      result.set(decompressed.subarray(0, uncompressedSize));
      entries.set(name, result);
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
};

// --- ZIP writer ---

const deflateData = async (data: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  // Copy into a fresh ArrayBuffer to satisfy the BufferSource type constraint
  const copy = new Uint8Array(data.length);
  copy.set(data);
  void writer.write(copy).then(() => writer.close());
  return collectStreamChunks(cs.readable);
};

/** CRC-32 computation. */
const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc32Table[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Write a ZIP file from entries. */
export const writeZip = async (entries: Map<string, Uint8Array>): Promise<Blob> => {
  const parts: ArrayBuffer[] = [];
  const centralDir: ArrayBuffer[] = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const compressed = await deflateData(data);
    const crcVal = crc32(data);

    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const lhView = new DataView(localHeader);
    lhView.setUint32(0, LOCAL_FILE_HEADER_SIG, true);
    lhView.setUint16(4, 20, true);
    lhView.setUint16(8, 8, true);
    lhView.setUint32(14, crcVal, true);
    lhView.setUint32(18, compressed.length, true);
    lhView.setUint32(22, data.length, true);
    lhView.setUint16(26, nameBytes.length, true);
    new Uint8Array(localHeader).set(nameBytes, 30);

    parts.push(localHeader);
    parts.push(compressed.buffer as ArrayBuffer);

    const cdEntry = new ArrayBuffer(46 + nameBytes.length);
    const cdView = new DataView(cdEntry);
    cdView.setUint32(0, CENTRAL_DIR_HEADER_SIG, true);
    cdView.setUint16(4, 20, true);
    cdView.setUint16(6, 20, true);
    cdView.setUint16(10, 8, true);
    cdView.setUint32(16, crcVal, true);
    cdView.setUint32(20, compressed.length, true);
    cdView.setUint32(24, data.length, true);
    cdView.setUint16(28, nameBytes.length, true);
    cdView.setUint32(42, offset, true);
    new Uint8Array(cdEntry).set(nameBytes, 46);

    centralDir.push(cdEntry);
    offset += localHeader.byteLength + compressed.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const cd of centralDir) {
    parts.push(cd);
    centralDirSize += cd.byteLength;
  }

  const eocd = new ArrayBuffer(22);
  const eocdView = new DataView(eocd);
  eocdView.setUint32(0, END_OF_CENTRAL_DIR_SIG, true);
  eocdView.setUint16(8, entries.size, true);
  eocdView.setUint16(10, entries.size, true);
  eocdView.setUint32(12, centralDirSize, true);
  eocdView.setUint32(16, centralDirOffset, true);
  parts.push(eocd);

  return new Blob(parts);
};

// --- OOXML slide helpers ---

const xmlParser = typeof DOMParser !== 'undefined' ? new DOMParser() : undefined;
const xmlSerializer = typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : undefined;

const parseXml = (xml: string): Document => {
  if (!xmlParser) throw ToolError.internal('DOMParser not available');
  return xmlParser.parseFromString(xml, 'application/xml');
};

const serializeXml = (doc: Document): string => {
  if (!xmlSerializer) throw ToolError.internal('XMLSerializer not available');
  return xmlSerializer.serializeToString(doc);
};

export const TEXT_DECODER = new TextDecoder();
export const TEXT_ENCODER = new TextEncoder();

/** Extract all text runs from a slide XML. */
export const extractSlideText = (slideXml: string): string[] => {
  const doc = parseXml(slideXml);
  const texts: string[] = [];
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (getLocalName(node) === 't' && node.textContent) {
      texts.push(node.textContent);
    }
    node = walker.nextNode();
  }
  return texts;
};

/** Extract speaker notes text from a notes XML file. */
export const extractNotesText = (notesXml: string): string => {
  const doc = parseXml(notesXml);
  const texts: string[] = [];
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (getLocalName(node) === 't' && node.textContent) {
      texts.push(node.textContent);
    }
    node = walker.nextNode();
  }
  return texts.join('');
};

/**
 * Get the list of slide filenames in presentation order.
 *
 * Slide order is determined by `<p:sldIdLst>` in `ppt/presentation.xml`, not
 * by the numeric suffix of the slide filename — inserted or duplicated slides
 * can have a `slideN.xml` filename whose position in the deck doesn't match
 * N. This walks sldIdLst, resolves each `r:id` against
 * `ppt/_rels/presentation.xml.rels`, and returns the absolute slide paths in
 * the order PowerPoint will render them.
 *
 * Falls back to numeric-suffix sort if either file is missing (defensive —
 * a well-formed PPTX always has both).
 */
export const getSlideList = (entries: Map<string, Uint8Array>): string[] => {
  const presRelsData = entries.get('ppt/_rels/presentation.xml.rels');
  if (!presRelsData) return [];

  // Build rId → slide target map from the rels file.
  const relsDoc = parseXml(TEXT_DECODER.decode(presRelsData));
  const relsWalker = relsDoc.createTreeWalker(relsDoc, NodeFilter.SHOW_ELEMENT);
  const rIdToTarget = new Map<string, string>();
  let relsNode = relsWalker.nextNode();
  while (relsNode) {
    if (isElement(relsNode) && getLocalName(relsNode) === 'Relationship') {
      const relType = relsNode.getAttribute('Type') ?? '';
      if (relType.includes('/slide') && !relType.includes('Layout') && !relType.includes('Master')) {
        const id = relsNode.getAttribute('Id') ?? '';
        const target = relsNode.getAttribute('Target') ?? '';
        if (id && target) rIdToTarget.set(id, target);
      }
    }
    relsNode = relsWalker.nextNode();
  }

  // Walk sldIdLst in presentation.xml to get the authoritative slide order.
  const presData = entries.get('ppt/presentation.xml');
  if (presData) {
    const presDoc = parseXml(TEXT_DECODER.decode(presData));
    const presWalker = presDoc.createTreeWalker(presDoc, NodeFilter.SHOW_ELEMENT);
    let sldIdLst: Element | null = null;
    let node = presWalker.nextNode();
    while (node) {
      if (isElement(node) && getLocalName(node) === 'sldIdLst') {
        sldIdLst = node;
        break;
      }
      node = presWalker.nextNode();
    }

    if (sldIdLst) {
      const ordered: string[] = [];
      for (const child of Array.from(sldIdLst.childNodes)) {
        if (!isElement(child) || getLocalName(child) !== 'sldId') continue;
        // r:id lookup is namespace-aware; try common variants.
        const rId =
          child.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ||
          child.getAttribute('r:id') ||
          '';
        const target = rIdToTarget.get(rId);
        if (target) ordered.push(`ppt/${target}`);
      }
      if (ordered.length > 0) return ordered;
    }
  }

  // Fallback: sort rels entries by numeric suffix of their target path.
  const fallback = Array.from(rIdToTarget.values()).sort((a, b) => {
    const numA = Number.parseInt(a.match(/slide(\d+)/)?.[1] ?? '0', 10);
    const numB = Number.parseInt(b.match(/slide(\d+)/)?.[1] ?? '0', 10);
    return numA - numB;
  });
  return fallback.map(t => `ppt/${t}`);
};

/** Get the notes filename for a given slide. */
export const getNotesForSlide = (entries: Map<string, Uint8Array>, slideFile: string): string | null => {
  const slideBaseName = slideFile.split('/').pop()?.replace('.xml', '') ?? '';
  const relsPath = `ppt/slides/_rels/${slideBaseName}.xml.rels`;
  const relsData = entries.get(relsPath);
  if (!relsData) return null;

  const relsXml = TEXT_DECODER.decode(relsData);
  const doc = parseXml(relsXml);
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (isElement(node) && getLocalName(node) === 'Relationship') {
      if ((node.getAttribute('Type') ?? '').includes('/notesSlide')) {
        const target = node.getAttribute('Target') ?? '';
        if (target) return `ppt/notesSlides/${target.split('/').pop()}`;
      }
    }
    node = walker.nextNode();
  }
  return null;
};

// --- Download/Upload helpers ---

/**
 * Guidance for HTTP 423 from Graph `/content`. The file is held by a WOPI
 * co-authoring lock — almost always because it is open in the PowerPoint web
 * editor in this very browser. Graph cannot overwrite a locked file, so the
 * only path is to close the editor (or wait for the lock to lapse) and retry.
 */
const FILE_LOCKED_MESSAGE =
  'The presentation is locked because it is open in the PowerPoint web editor (or another co-authoring session), so Microsoft Graph cannot save changes to it. Close the editor tab — or wait ~30–60 seconds after closing for the lock to release — then retry. Any pending session edits are preserved.';

interface ItemMetadata {
  eTag?: string;
  '@microsoft.graph.downloadUrl'?: string;
}

/** Fetch item metadata from the Graph API. Used both for downloads and eTag verification. */
const fetchItemMetadata = async (driveId: string, itemId: string, token: string): Promise<ItemMetadata> => {
  const resp = await fetch(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw ToolError.internal(`Failed to get item metadata: ${resp.status}`);
  return (await resp.json()) as ItemMetadata;
};

/** Fetch the PPTX bytes via a pre-authenticated download URL. */
const fetchPptxBytes = async (downloadUrl: string): Promise<Blob> => {
  const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw ToolError.internal(`Failed to download PPTX: ${resp.status}`);
  return resp.blob();
};

/**
 * Download a PPTX from the Graph API and return its ZIP entries.
 *
 * If a session is open for `{driveId}:{itemId}`, returns the cached entries
 * by reference — tools mutate in place and the changes persist in the
 * session until `commit_presentation` or `discard_presentation` is called.
 */
export const downloadPptx = async (itemId: string): Promise<Map<string, Uint8Array>> => {
  const { token, driveId } = await requireAuth();

  // Session fast path — skip both the metadata fetch and the content download.
  const session = touchSession(driveId, itemId);
  if (session) return session.entries;

  const itemData = await fetchItemMetadata(driveId, itemId, token);
  const downloadUrl = itemData['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) throw ToolError.internal('No download URL available');

  const blob = await fetchPptxBytes(downloadUrl);
  return readZip(blob);
};

/**
 * Upload a PPTX to the Graph API by re-zipping the entries.
 *
 * If a session is open for `{driveId}:{itemId}`, no HTTP happens — the
 * session is marked dirty and the updated entries map is retained so that
 * `commit_presentation` can flush them later.
 */
export const uploadPptx = async (itemId: string, entries: Map<string, Uint8Array>): Promise<void> => {
  const { token, driveId } = await requireAuth();

  // Session fast path — defer the actual upload until commit.
  const session = touchSession(driveId, itemId);
  if (session) {
    session.entries = entries;
    session.dirty = true;
    return;
  }

  const blob = await writeZip(entries);
  const url = `${GRAPH_BASE}/drives/${driveId}/items/${itemId}/content`;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
    body: blob,
    signal: AbortSignal.timeout(60_000),
  });
  if (resp.status === 423) throw ToolError.validation(FILE_LOCKED_MESSAGE);
  if (!resp.ok) {
    const errorBody = (await resp.text().catch(() => '')).substring(0, 512);
    throw ToolError.internal(`Failed to upload PPTX: ${resp.status} — ${errorBody}`);
  }
};

// --- Phase 4: session operations ---

export interface OpenPresentationResult {
  item_id: string;
  drive_id: string;
  etag: string;
  slides: number;
  opened_at: number;
}

/**
 * Open an edit session for a presentation. Downloads the PPTX once, captures
 * its eTag, and stores an in-memory copy. Subsequent edit tools will mutate
 * the cached copy until `commitPresentation` or `discardPresentation`.
 *
 * Rejects if a session is already open for this item — agents should
 * explicitly commit or discard before re-opening.
 */
export const openPresentation = async (itemId: string): Promise<OpenPresentationResult> => {
  const { token, driveId } = await requireAuth();

  const existing = peekSession(driveId, itemId);
  if (existing) {
    throw ToolError.validation(
      `A session is already open for item ${itemId} (opened ${Math.round((Date.now() - existing.openedAt) / 1000)}s ago, dirty=${existing.dirty}). ` +
        `Call commit_presentation or discard_presentation before opening a new session.`,
    );
  }

  const itemData = await fetchItemMetadata(driveId, itemId, token);
  const downloadUrl = itemData['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) throw ToolError.internal('No download URL available');
  const etag = itemData.eTag;
  if (!etag) {
    throw ToolError.internal('Item metadata missing eTag — cannot guarantee safe commit. Refusing to open a session.');
  }

  const blob = await fetchPptxBytes(downloadUrl);
  const entries = await readZip(blob);

  const now = Date.now();
  const session: PresentationSession = {
    driveId,
    itemId,
    entries,
    etag,
    openedAt: now,
    lastAccessedAt: now,
    dirty: false,
  };
  storeSession(session);

  return {
    item_id: itemId,
    drive_id: driveId,
    etag,
    slides: getSlideList(entries).length,
    opened_at: now,
  };
};

export interface CommitPresentationResult {
  item_id: string;
  slides: number;
  was_dirty: boolean;
  committed: boolean;
}

/**
 * Flush a session's pending edits to the Graph API using an optimistic
 * `If-Match` conditional PUT. If the server's eTag no longer matches the
 * one captured at open time (someone else edited the file in the browser),
 * the PUT returns 412 and this throws — pending edits are NOT saved and the
 * session stays open so the agent can choose to discard and re-open.
 *
 * If the session is clean (nothing mutated), skips the upload and just
 * clears the session.
 */
export const commitPresentation = async (itemId: string, driveId?: string): Promise<CommitPresentationResult> => {
  const { token, driveId: currentDriveId } = await requireAuth();

  // Look the session up under the explicit drive when given (e.g. from
  // list_presentation_sessions after the tab navigated to another deck),
  // otherwise the current tab's drive.
  const session = touchSession(driveId ?? currentDriveId, itemId);
  if (!session) {
    throw ToolError.notFound(
      `No open session for item ${itemId}. Call open_presentation first, or the previous session expired after 10 minutes of inactivity.`,
    );
  }

  const slides = getSlideList(session.entries).length;

  if (!session.dirty) {
    deleteSession(session.driveId, session.itemId);
    return { item_id: itemId, slides, was_dirty: false, committed: true };
  }

  // Commit against the session's own drive/item — the file lives there
  // regardless of which deck the tab currently shows.
  const blob = await writeZip(session.entries);
  const url = `${GRAPH_BASE}/drives/${session.driveId}/items/${session.itemId}/content`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'If-Match': session.etag,
    },
    body: blob,
    signal: AbortSignal.timeout(60_000),
  });

  if (resp.status === 412) {
    throw ToolError.validation(
      `File changed in the browser since open_presentation (ETag mismatch). ` +
        `Pending edits were NOT saved. Call discard_presentation and then open_presentation to reload the latest version, ` +
        `or commit individual changes without a session.`,
    );
  }
  if (resp.status === 423) {
    // Leave the session in place — its dirty edits are preserved so the caller
    // can close the editor (releasing the lock) and call commit again.
    throw ToolError.validation(FILE_LOCKED_MESSAGE);
  }
  if (!resp.ok) {
    const errorBody = (await resp.text().catch(() => '')).substring(0, 512);
    // Leave the session in place so the caller can retry or discard.
    throw ToolError.internal(`Failed to commit session: ${resp.status} — ${errorBody}`);
  }

  deleteSession(session.driveId, session.itemId);
  return { item_id: itemId, slides, was_dirty: true, committed: true };
};

export interface DiscardPresentationResult {
  item_id: string;
  discarded: boolean;
}

/** Drop a session without uploading. Idempotent — returns discarded=false if nothing was open. */
export const discardPresentation = async (itemId: string, driveId?: string): Promise<DiscardPresentationResult> => {
  const { driveId: currentDriveId } = await requireAuth();
  const discarded = deleteSession(driveId ?? currentDriveId, itemId);
  return { item_id: itemId, discarded };
};

export interface ListedSession {
  drive_id: string;
  item_id: string;
  opened_at: number;
  last_accessed_at: number;
  dirty: boolean;
  slides: number;
  idle_seconds: number;
}

/** Summarize all open sessions. Purges expired sessions as a side effect. */
export const listPresentationSessions = (): ListedSession[] => {
  const now = Date.now();
  return listSessions().map(s => ({
    drive_id: s.driveId,
    item_id: s.itemId,
    opened_at: s.openedAt,
    last_accessed_at: s.lastAccessedAt,
    dirty: s.dirty,
    slides: getSlideList(s.entries).length,
    idle_seconds: Math.round((now - s.lastAccessedAt) / 1000),
  }));
};

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const childElementsByName = (parent: Element, localName: string): Element[] => {
  const out: Element[] = [];
  for (const n of parent.childNodes) if (isElement(n) && n.localName === localName) out.push(n);
  return out;
};

/**
 * Replace the text of a slide's first/primary text box with `newText`,
 * one paragraph per `\n`-separated line. The first existing paragraph's
 * `pPr` and the first run's `rPr` are reused as formatting templates so the
 * replacement keeps the original styling. Other text boxes on the slide are
 * left untouched — to edit a specific shape, use `update_shape`.
 */
export const replaceSlideText = (slideXml: string, newText: string): string => {
  const doc = parseXml(slideXml);

  // Prefer the first text body that already has a paragraph (an authored text
  // box); fall back to the first text body on the slide so empty placeholders
  // (a blank title or body) can still be populated.
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  let txBody: Element | null = null;
  let firstTxBody: Element | null = null;
  let node = walker.nextNode();
  while (node) {
    if (isElement(node) && getLocalName(node) === 'txBody') {
      if (!firstTxBody) firstTxBody = node;
      if (childElementsByName(node, 'p').length > 0) {
        txBody = node;
        break;
      }
    }
    node = walker.nextNode();
  }
  txBody = txBody ?? firstTxBody;
  if (!txBody) return serializeXml(doc);

  // Preserve formatting templates from the first paragraph / first run.
  let preservedPPr: Element | null = null;
  let preservedRPr: Element | null = null;
  const firstP = childElementsByName(txBody, 'p')[0];
  if (firstP) {
    const pPr = childElementsByName(firstP, 'pPr')[0];
    if (pPr) preservedPPr = pPr.cloneNode(true) as Element;
    const firstR = childElementsByName(firstP, 'r')[0];
    if (firstR) {
      const rPr = childElementsByName(firstR, 'rPr')[0];
      if (rPr) preservedRPr = rPr.cloneNode(true) as Element;
    }
  }

  for (const p of childElementsByName(txBody, 'p')) txBody.removeChild(p);

  const lines = newText.length > 0 ? newText.split('\n') : [''];
  for (const line of lines) {
    const p = doc.createElementNS(A_NS, 'a:p');
    if (preservedPPr) p.appendChild(preservedPPr.cloneNode(true));
    const r = doc.createElementNS(A_NS, 'a:r');
    if (preservedRPr) r.appendChild(preservedRPr.cloneNode(true));
    const t = doc.createElementNS(A_NS, 'a:t');
    t.textContent = line;
    r.appendChild(t);
    p.appendChild(r);
    txBody.appendChild(p);
  }

  return serializeXml(doc);
};

/**
 * Replace speaker notes text in a notes XML, one paragraph per `\n`-separated
 * line. Rebuilds the notes body's paragraphs (preserving the first paragraph's
 * `pPr`/`rPr` as templates), creating run/text nodes when the body is empty —
 * so it works on both authored and freshly-created notes parts.
 */
export const replaceNotesText = (notesXml: string, newText: string): string => {
  const doc = parseXml(notesXml);
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);

  // Prefer the body-placeholder txBody; fall back to the first txBody.
  let notesBody: Element | null = null;
  let firstTxBody: Element | null = null;
  let node = walker.nextNode();
  while (node) {
    if (isElement(node) && getLocalName(node) === 'txBody') {
      if (!firstTxBody) firstTxBody = node;
      const ph = node.parentElement?.querySelector('[type]');
      if (ph?.getAttribute('type')?.includes('body')) {
        notesBody = node;
        break;
      }
    }
    node = walker.nextNode();
  }
  notesBody = notesBody ?? firstTxBody;
  if (!notesBody) return serializeXml(doc);

  let preservedPPr: Element | null = null;
  let preservedRPr: Element | null = null;
  const firstP = childElementsByName(notesBody, 'p')[0];
  if (firstP) {
    const pPr = childElementsByName(firstP, 'pPr')[0];
    if (pPr) preservedPPr = pPr.cloneNode(true) as Element;
    const firstR = childElementsByName(firstP, 'r')[0];
    if (firstR) {
      const rPr = childElementsByName(firstR, 'rPr')[0];
      if (rPr) preservedRPr = rPr.cloneNode(true) as Element;
    }
  }

  for (const p of childElementsByName(notesBody, 'p')) notesBody.removeChild(p);

  const lines = newText.length > 0 ? newText.split('\n') : [''];
  for (const line of lines) {
    const p = doc.createElementNS(A_NS, 'a:p');
    if (preservedPPr) p.appendChild(preservedPPr.cloneNode(true));
    const r = doc.createElementNS(A_NS, 'a:r');
    if (preservedRPr) r.appendChild(preservedRPr.cloneNode(true));
    const t = doc.createElementNS(A_NS, 'a:t');
    t.textContent = line;
    r.appendChild(t);
    p.appendChild(r);
    notesBody.appendChild(p);
  }

  return serializeXml(doc);
};
