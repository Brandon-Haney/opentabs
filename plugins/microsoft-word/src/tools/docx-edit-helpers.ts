/**
 * Shared helpers for tools that download, modify, and re-upload .docx files.
 */
import { ToolError } from '@opentabs-dev/plugin-sdk';
import { DOCX_MIME, extractAllZipEntries, rebuildZip, toArrayBuffer, type ZipEntry } from '../docx-utils.js';
import { api, fetchDownloadUrl, graphFetch, METADATA_TIMEOUT_MS } from '../microsoft-word-api.js';

interface DownloadableItem {
  '@microsoft.graph.downloadUrl'?: string;
  file?: { mimeType?: string };
  eTag?: string;
}

/** A document's bytes and the item version they were read at. */
export interface DocxSnapshot {
  bytes: Uint8Array;
  /** The item's `eTag` at read time, or undefined when Graph did not report one. */
  eTag: string | undefined;
}

const isWordMimeType = (mimeType: string): boolean =>
  mimeType.includes('wordprocessingml') || mimeType.includes('msword');

/**
 * Download a Word document's bytes: reads the item's pre-authenticated download
 * URL from Graph within METADATA_TIMEOUT_MS, rejects files whose MIME type is
 * not a Word document, and fetches the binary from that URL under the default
 * request budget.
 */
export async function downloadDocxBytes(itemId: string): Promise<DocxSnapshot> {
  const meta = await api<DownloadableItem>(`/me/drive/items/${itemId}`, { timeoutMs: METADATA_TIMEOUT_MS });

  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) {
    throw ToolError.internal('No download URL available for this item.');
  }

  const mimeType = meta.file?.mimeType ?? '';
  if (mimeType && !isWordMimeType(mimeType)) {
    throw ToolError.validation(
      `This file is not a Word document (${mimeType}). Only .docx files can be read or edited with the document tools — use get_file_content for text-based files.`,
    );
  }

  const response = await fetchDownloadUrl(downloadUrl);
  return { bytes: new Uint8Array(await response.arrayBuffer()), eTag: meta.eTag };
}

/** Download a .docx file and return all ZIP entries plus the document.xml as text. */
export async function downloadDocxEntries(itemId: string): Promise<{
  entries: ZipEntry[];
  documentXml: string;
  documentXmlIndex: number;
  /** The item version the entries were read at; pass it back to uploadModifiedDocx. */
  eTag: string | undefined;
}> {
  const { bytes, eTag } = await downloadDocxBytes(itemId);

  const entries = await extractAllZipEntries(bytes);
  const docIndex = entries.findIndex(e => e.name === 'word/document.xml');
  if (docIndex === -1) {
    throw ToolError.internal('Could not find word/document.xml in the .docx archive.');
  }

  const entry = entries[docIndex];
  if (!entry) {
    throw ToolError.internal('Could not read word/document.xml from the .docx archive.');
  }
  const documentXml = new TextDecoder().decode(entry.data);
  return { entries, documentXml, documentXmlIndex: docIndex, eTag };
}

/**
 * Replace the document.xml in entries and re-upload the .docx to OneDrive.
 *
 * This rewrites the WHOLE file, so anything written between the read and this
 * upload would be replaced wholesale. `eTag` is the version the entries were
 * read at: Graph answers 412 rather than accepting the write once the item has
 * moved on, which turns a silent overwrite into a refusal the caller can act on.
 *
 * That guard is also what makes the replay safe. The bytes are fixed inside this
 * call, so a replay after a hidden success re-sends identical content — and with
 * the version pinned, a replay that lands after someone else's edit is refused
 * instead of clobbering it.
 */
export async function uploadModifiedDocx(
  itemId: string,
  entries: ZipEntry[],
  documentXmlIndex: number,
  newDocumentXml: string,
  eTag: string | undefined,
): Promise<void> {
  entries[documentXmlIndex] = {
    name: 'word/document.xml',
    data: new TextEncoder().encode(newDocumentXml),
  };

  const response = await graphFetch(`/me/drive/items/${itemId}/content`, {
    method: 'PUT',
    body: toArrayBuffer(rebuildZip(entries)),
    contentType: DOCX_MIME,
    retryNonIdempotent: true,
    ...(eTag !== undefined ? { ifMatch: eTag } : {}),
  });
  if (response.status === 412) {
    void response.body?.cancel().catch(() => undefined);
    throw ToolError.validation(
      'The document changed while this edit was being prepared, so writing it would have discarded that change. ' +
        'Read the document again and re-apply the edit.',
      'DOCUMENT_CHANGED',
    );
  }
  void response.body?.cancel().catch(() => undefined);
}
