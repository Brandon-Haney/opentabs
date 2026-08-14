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
import { A_NS, getLocalName, isElement, parseXml, serializeXml } from './xml.js';

// --- ZIP constants ---
const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

// --- Helpers ---

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
  // Snapshot the map before compressing. Deflating each entry yields to the
  // event loop, and the map being written may be a live session's — another
  // tool call landing between two entries would otherwise put pre- and
  // post-edit parts in one archive, and change `entries.size` after the count
  // had already been written into the end-of-central-directory record.
  const snapshot = Array.from(entries);

  const parts: ArrayBuffer[] = [];
  const centralDir: ArrayBuffer[] = [];
  let offset = 0;

  for (const [name, data] of snapshot) {
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
  eocdView.setUint16(8, snapshot.length, true);
  eocdView.setUint16(10, snapshot.length, true);
  eocdView.setUint32(12, centralDirSize, true);
  eocdView.setUint32(16, centralDirOffset, true);
  parts.push(eocd);

  return new Blob(parts);
};

// --- OOXML slide helpers ---

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

/** Path of the `.rels` part describing a given part. */
export const relsPathFor = (partPath: string): string => {
  const segments = partPath.split('/');
  const fileName = segments.pop() ?? '';
  return [...segments, '_rels', `${fileName}.rels`].join('/');
};

/**
 * Resolve a relationship `Target` to a package-absolute path.
 *
 * Targets are relative to the directory of the part that owns the `.rels`
 * file, so `ppt/slides/slide3.xml` + `../comments/c.xml` → `ppt/comments/c.xml`.
 * Never derive the destination from a filename convention — OOXML producers are
 * free to place a related part anywhere, and several of Microsoft's newer part
 * types have no documented path at all.
 */
export const resolveRelTarget = (sourcePartPath: string, target: string): string => {
  if (target.startsWith('/')) return target.slice(1);
  const segments = sourcePartPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
};

/**
 * Package-absolute paths of every part related to `sourcePartPath` whose
 * relationship `Type` contains `relTypeSubstring`, in relationship order.
 *
 * External targets are skipped — they name a URL, not a part.
 */
export const getRelatedParts = (
  entries: Map<string, Uint8Array>,
  sourcePartPath: string,
  relTypeSubstring: string,
): string[] => {
  const relsData = entries.get(relsPathFor(sourcePartPath));
  if (!relsData) return [];

  const doc = parseXml(TEXT_DECODER.decode(relsData));
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  const targets: string[] = [];
  let node = walker.nextNode();
  while (node) {
    if (isElement(node) && getLocalName(node) === 'Relationship' && node.getAttribute('TargetMode') !== 'External') {
      const target = node.getAttribute('Target') ?? '';
      if (target && (node.getAttribute('Type') ?? '').includes(relTypeSubstring)) {
        targets.push(resolveRelTarget(sourcePartPath, target));
      }
    }
    node = walker.nextNode();
  }
  return targets;
};

/** Get the notes part path for a given slide, or null when it has none. */
export const getNotesForSlide = (entries: Map<string, Uint8Array>, slideFile: string): string | null =>
  getRelatedParts(entries, slideFile, '/relationships/notesSlide')[0] ?? null;

/**
 * Resolve a 1-indexed slide number to its package path.
 *
 * Slide numbers come from agents, so an out-of-range one is an ordinary input
 * error rather than a defect — the message names the deck's actual length so the
 * caller can correct itself without another read.
 */
export const requireSlideFile = (entries: Map<string, Uint8Array>, slideNumber: number): string => {
  const slideFiles = getSlideList(entries);
  const file = slideNumber >= 1 ? slideFiles[slideNumber - 1] : undefined;
  if (!file) {
    throw ToolError.notFound(`Slide ${slideNumber} not found — presentation has ${slideFiles.length} slides`);
  }
  return file;
};

/** Read a slide part's XML out of the package. */
export const readSlideXml = (entries: Map<string, Uint8Array>, slideFile: string): string => {
  const data = entries.get(slideFile);
  if (!data) throw ToolError.internal(`Slide file not found in archive: ${slideFile}`);
  return TEXT_DECODER.decode(data);
};

/** Write a slide part's XML back into the package. */
export const writeSlideXml = (entries: Map<string, Uint8Array>, slideFile: string, slideXml: string): void => {
  entries.set(slideFile, TEXT_ENCODER.encode(slideXml));
};

// --- Download/Upload helpers ---

/**
 * Guidance for HTTP 423 from Graph `/content`. The file is held by a WOPI
 * co-authoring lock — almost always because it is open in the PowerPoint web
 * editor in this very browser. Graph cannot overwrite a locked file, so the
 * only path is to close the editor (or wait for the lock to lapse) and retry.
 *
 * The lock outlives the editor tab: the server keeps the co-authoring session
 * alive for several minutes after the last client disconnects, and no request
 * shortens that. Measured at roughly four minutes.
 */
const FILE_LOCKED_MESSAGE =
  'The presentation is locked because it is open in the PowerPoint web editor (or another co-authoring session), so Microsoft Graph cannot save changes to it. Close the editor tab and retry — the server holds the lock for a few minutes after the last editor disconnects, so expect to wait rather than to retry immediately. Any pending session edits are preserved.';

/**
 * Guidance after `editPresentation` runs out of attempts. Distinct from the
 * lock case: the file is writable, someone else is simply saving it faster than
 * a read-modify-write round trip can complete.
 */
const CONCURRENT_EDIT_MESSAGE =
  'Another editor saved this presentation between each read and write attempt, so the change could not be applied without discarding their work. Nothing was overwritten and nothing was saved. Retry when the deck is quieter, or call open_presentation to batch edits behind a single guarded save.';

const PPTX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Read-modify-write attempts before giving up. A save loses the race only if
 * someone else saved during the round trip; losing it three times running means
 * the deck is under active editing, and a fourth attempt would not fare better.
 */
const MAX_SAVE_ATTEMPTS = 3;

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

/** A package as it stood on the server, paired with the version it was read at. */
interface PackageSnapshot {
  entries: Map<string, Uint8Array>;
  /**
   * The item's eTag at read time, used as the `If-Match` precondition on the
   * write. Absent only if Graph omits it, in which case the write proceeds
   * unguarded — there is nothing to compare against.
   */
  etag: string | undefined;
}

/** Read the saved package and the version it was read at, in one round trip. */
const readPackage = async (driveId: string, itemId: string, token: string): Promise<PackageSnapshot> => {
  const itemData = await fetchItemMetadata(driveId, itemId, token);
  const downloadUrl = itemData['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) throw ToolError.internal('No download URL available');
  const blob = await fetchPptxBytes(downloadUrl);
  return { entries: await readZip(blob), etag: itemData.eTag };
};

/**
 * Write the package back, refusing to overwrite a newer version.
 *
 * Returns `false` when the precondition failed — the file moved on since it was
 * read, and this save would have discarded whatever changed. Every other failure
 * throws, because only the lost-update case has a sensible recovery.
 */
const savePackage = async (
  driveId: string,
  itemId: string,
  token: string,
  entries: Map<string, Uint8Array>,
  etag: string | undefined,
): Promise<boolean> => {
  const blob = await writeZip(entries);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': PPTX_CONTENT_TYPE,
  };
  if (etag) headers['If-Match'] = etag;

  const resp = await fetch(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}/content`, {
    method: 'PUT',
    headers,
    body: blob,
    signal: AbortSignal.timeout(60_000),
  });

  if (resp.status === 412) return false;
  if (resp.status === 423) throw ToolError.validation(FILE_LOCKED_MESSAGE);
  if (!resp.ok) {
    const errorBody = (await resp.text().catch(() => '')).substring(0, 512);
    throw ToolError.internal(`Failed to upload PPTX: ${resp.status} — ${errorBody}`);
  }
  return true;
};

/**
 * Download a PPTX from the Graph API and return its ZIP entries.
 *
 * If a session is open for `{driveId}:{itemId}`, returns the cached entries
 * by reference — tools mutate in place and the changes persist in the
 * session until `commit_presentation` or `discard_presentation` is called.
 */
export const downloadPptx = async (itemId: string, explicitDriveId?: string): Promise<Map<string, Uint8Array>> => {
  const { token, driveId } = await requireAuth(explicitDriveId);

  // Session fast path — skip both the metadata fetch and the content download.
  const session = touchSession(driveId, itemId);
  if (session) return session.entries;

  return (await readPackage(driveId, itemId, token)).entries;
};

/**
 * Whether an `open_presentation` session is currently holding this item.
 *
 * Read tools use this to tell callers that a result came from a session
 * snapshot rather than the saved file. Uses `peekSession` so that merely
 * asking does not extend the session's idle timeout.
 */
export const isSessionOpen = async (itemId: string, explicitDriveId?: string): Promise<boolean> => {
  const { driveId } = await requireAuth(explicitDriveId);
  return peekSession(driveId, itemId) !== undefined;
};

/**
 * Apply an edit to a presentation and save it, without discarding anyone else's work.
 *
 * Saving means PUTting the entire package, so an unguarded write silently
 * replaces every change made since the read — a co-author's paragraph simply
 * disappears, with no error anywhere to say so. The write therefore carries the
 * version the read observed as an `If-Match` precondition, which turns a lost
 * update into a rejected save.
 *
 * A rejected save is not a failed edit. `mutate` is expressed as a function of
 * the package rather than as a fixed set of bytes, so it is re-applied to a
 * freshly read package and saved again; the caller sees a conflict only when the
 * deck is being edited faster than a round trip completes.
 *
 * With a session open the edit lands in the in-memory copy instead, and
 * `commit_presentation` performs the one guarded save for the whole batch.
 */
export const editPresentation = async <T>(
  itemId: string,
  explicitDriveId: string | undefined,
  mutate: (entries: Map<string, Uint8Array>) => T | Promise<T>,
): Promise<T> => {
  const { token, driveId } = await requireAuth(explicitDriveId);

  const session = touchSession(driveId, itemId);
  if (session) {
    // Edits replace whole entries rather than writing through the byte arrays
    // already in the map, so a shallow copy restores the package if `mutate`
    // throws part-way. Without it a failed edit would leave the session holding
    // half a change that the next commit would save as though it were intended.
    const rollback = new Map(session.entries);
    try {
      const result = await mutate(session.entries);
      session.dirty = true;
      return result;
    } catch (err) {
      session.entries = rollback;
      throw err;
    }
  }

  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
    const { entries, etag } = await readPackage(driveId, itemId, token);
    const result = await mutate(entries);
    if (await savePackage(driveId, itemId, token, entries, etag)) return result;
  }
  throw ToolError.validation(CONCURRENT_EDIT_MESSAGE);
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
export const openPresentation = async (itemId: string, explicitDriveId?: string): Promise<OpenPresentationResult> => {
  const { token, driveId } = await requireAuth(explicitDriveId);

  const existing = peekSession(driveId, itemId);
  if (existing) {
    throw ToolError.validation(
      `A session is already open for item ${itemId} (opened ${Math.round((Date.now() - existing.openedAt) / 1000)}s ago, dirty=${existing.dirty}). ` +
        `Call commit_presentation or discard_presentation before opening a new session.`,
    );
  }

  const { entries, etag } = await readPackage(driveId, itemId, token);
  if (!etag) {
    throw ToolError.internal('Item metadata missing eTag — cannot guarantee safe commit. Refusing to open a session.');
  }

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
  // Resolve against the drive the caller named. Deriving it from the tab
  // instead would throw whenever the tab has moved off a presentation, which is
  // exactly the situation `drive_id` exists to handle — and would strand a
  // dirty session as neither committable nor discardable until it expired.
  const { token, driveId: currentDriveId } = await requireAuth(driveId);

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
  // regardless of which deck the tab currently shows. A rejected save cannot be
  // retried here the way `editPresentation` retries: a session's edits are bytes
  // accumulated over many tool calls, not a function that can be re-applied to
  // newer content. Every failure therefore leaves the session in place, with its
  // pending edits intact, for the caller to retry or discard.
  const saved = await savePackage(session.driveId, session.itemId, token, session.entries, session.etag);
  if (!saved) {
    throw ToolError.validation(
      `File changed in the browser since open_presentation (ETag mismatch). ` +
        `Pending edits were NOT saved. Call discard_presentation and then open_presentation to reload the latest version, ` +
        `or commit individual changes without a session.`,
    );
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
  const { driveId: currentDriveId } = await requireAuth(driveId);
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
