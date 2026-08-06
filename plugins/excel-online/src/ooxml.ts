import { ToolError } from '@opentabs-dev/plugin-sdk';

/**
 * Minimal read-only reader for OOXML packages (ZIP archives).
 *
 * An `.xlsx` file is a ZIP whose entries are XML "parts". Microsoft Graph
 * exposes PivotTables, workbook connections and pivot caches nowhere in its
 * workbook API at any version, so the only way to read them is to download the
 * package and parse the parts directly.
 *
 * Inflation uses the platform's native `DecompressionStream('deflate-raw')`,
 * which is what a ZIP's deflate payload is — so there is no dependency here.
 *
 * Only the read path is implemented. Nothing in this module writes ZIPs.
 */

const EOCD_SIGNATURE = 0x0605_4b50;
const EOCD64_LOCATOR_SIGNATURE = 0x0706_4b50;
const EOCD64_SIGNATURE = 0x0606_4b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x0201_4b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;

/** Fixed size of the end-of-central-directory record, excluding its comment. */
const EOCD_FIXED_SIZE = 22;
/** Largest possible EOCD record: the fixed part plus a maximum-length comment. */
const MAX_EOCD_SIZE = EOCD_FIXED_SIZE + 0xffff;
/** Sentinel a 32-bit ZIP field carries when its real value lives in a Zip64 record. */
const ZIP64_SENTINEL_32 = 0xffff_ffff;
const ZIP64_SENTINEL_16 = 0xffff;

/** One entry from the ZIP central directory. Offsets are absolute within the package. */
export interface ZipEntry {
  /** Part name, e.g. `xl/pivotTables/pivotTable1.xml`. */
  name: string;
  /** ZIP compression method — 0 is stored, 8 is deflate. */
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Absolute offset of this entry's local file header within the package. */
  localHeaderOffset: number;
}

/** A 64-bit ZIP field widened to a JS number, rejecting values that would lose precision. */
const toSafeInteger = (value: bigint, field: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw ToolError.internal(`Workbook package is too large to read: ${field} exceeds the safe integer range.`);
  }
  return Number(value);
};

/**
 * Locate the end-of-central-directory record by scanning backwards from the end
 * of `bytes`. The record sits at the very end unless the archive carries a
 * comment, so the scan is bounded by the largest a comment may be.
 *
 * Returns the offset of the record within `bytes`, or -1 when absent.
 */
const findEocdOffset = (view: DataView, length: number): number => {
  const earliest = Math.max(0, length - MAX_EOCD_SIZE);
  for (let offset = length - EOCD_FIXED_SIZE; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
};

/** Where the central directory lives and how many entries it holds. */
export interface CentralDirectoryLocation {
  /** Absolute offset of the central directory within the package. */
  offset: number;
  size: number;
  entryCount: number;
}

/**
 * Read the central directory's location out of the EOCD record, following the
 * Zip64 locator when the 32-bit fields are saturated.
 *
 * `windowStart` is the absolute package offset that `view` begins at, so that
 * this works both on a full package and on a suffix fetched by a Range request.
 */
const readCentralDirectoryLocation = (view: DataView, windowStart: number, eocd: number): CentralDirectoryLocation => {
  let entryCount = view.getUint16(eocd + 10, true);
  let size = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);

  const needsZip64 = entryCount === ZIP64_SENTINEL_16 || size === ZIP64_SENTINEL_32 || offset === ZIP64_SENTINEL_32;
  if (!needsZip64) return { offset, size, entryCount };

  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== EOCD64_LOCATOR_SIGNATURE) {
    throw ToolError.internal('Workbook package is a Zip64 archive but its Zip64 locator is missing or unreadable.');
  }
  const eocd64Absolute = toSafeInteger(view.getBigUint64(locator + 8, true), 'Zip64 directory offset');
  const eocd64 = eocd64Absolute - windowStart;
  if (eocd64 < 0 || view.getUint32(eocd64, true) !== EOCD64_SIGNATURE) {
    throw ToolError.internal('Workbook package Zip64 end-of-central-directory record is outside the fetched window.');
  }
  entryCount = toSafeInteger(view.getBigUint64(eocd64 + 32, true), 'Zip64 entry count');
  size = toSafeInteger(view.getBigUint64(eocd64 + 40, true), 'Zip64 directory size');
  offset = toSafeInteger(view.getBigUint64(eocd64 + 48, true), 'Zip64 directory offset');
  return { offset, size, entryCount };
};

/**
 * Pull the real 64-bit values out of a central-directory entry's Zip64 extra
 * field. The record carries only the fields whose 32-bit counterpart was
 * saturated, in a fixed order, so presence is derived from the 32-bit values.
 */
const applyZip64Extra = (
  view: DataView,
  extraStart: number,
  extraLength: number,
  entry: { compressedSize: number; uncompressedSize: number; localHeaderOffset: number },
): void => {
  let cursor = extraStart;
  const end = extraStart + extraLength;
  while (cursor + 4 <= end) {
    const fieldId = view.getUint16(cursor, true);
    const fieldSize = view.getUint16(cursor + 2, true);
    if (fieldId !== ZIP64_EXTRA_FIELD_ID) {
      cursor += 4 + fieldSize;
      continue;
    }
    let value = cursor + 4;
    if (entry.uncompressedSize === ZIP64_SENTINEL_32) {
      entry.uncompressedSize = toSafeInteger(view.getBigUint64(value, true), 'entry size');
      value += 8;
    }
    if (entry.compressedSize === ZIP64_SENTINEL_32) {
      entry.compressedSize = toSafeInteger(view.getBigUint64(value, true), 'entry compressed size');
      value += 8;
    }
    if (entry.localHeaderOffset === ZIP64_SENTINEL_32) {
      entry.localHeaderOffset = toSafeInteger(view.getBigUint64(value, true), 'entry header offset');
    }
    return;
  }
};

/**
 * Read where the central directory lives, from a window that ends at the end of
 * the package. Returns `null` when no end-of-central-directory record is in the
 * window, which means the window is too small (or the bytes are not a ZIP).
 *
 * `windowStart` is the absolute package offset `bytes` begins at — 0 for a full
 * package, or `total - bytes.length` for a suffix fetched by a Range request.
 */
export const locateCentralDirectory = (bytes: Uint8Array, windowStart = 0): CentralDirectoryLocation | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocdOffset(view, bytes.byteLength);
  if (eocd < 0) return null;
  return readCentralDirectoryLocation(view, windowStart, eocd);
};

/**
 * Parse `entryCount` central-directory records starting at `start` within `bytes`.
 *
 * Stops early if a record's signature does not match, so a truncated or
 * misaligned directory yields the entries that were readable rather than
 * throwing on trailing garbage.
 */
export const parseCentralDirectoryEntries = (bytes: Uint8Array, start: number, entryCount: number): ZipEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  let cursor = start;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== CENTRAL_FILE_HEADER_SIGNATURE) break;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const entry: ZipEntry = {
      name: decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      compressionMethod: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localHeaderOffset: view.getUint32(cursor + 42, true),
    };
    applyZip64Extra(view, cursor + 46 + nameLength, extraLength, entry);
    entries.push(entry);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

/**
 * Parse the central directory out of a suffix of the package, without knowing
 * the package's total size.
 *
 * In a plain ZIP the end-of-central-directory record sits immediately after the
 * directory, so the directory's position within the suffix is exactly
 * `eocdOffset - directorySize` — no absolute offsets and no size lookup needed.
 * That identity does not hold for Zip64 archives, which interpose two more
 * records, so those return `null` for the caller to fall back to a full read.
 *
 * Also returns `null` when the directory starts before the suffix begins, which
 * means the Range window was too small.
 */
export const parseCentralDirectoryFromSuffix = (suffix: Uint8Array): ZipEntry[] | null => {
  const view = new DataView(suffix.buffer, suffix.byteOffset, suffix.byteLength);
  const eocd = findEocdOffset(view, suffix.byteLength);
  if (eocd < 0) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (entryCount === ZIP64_SENTINEL_16 || size === ZIP64_SENTINEL_32 || offset === ZIP64_SENTINEL_32) return null;

  const start = eocd - size;
  if (start < 0) return null;
  return parseCentralDirectoryEntries(suffix, start, entryCount);
};

/**
 * Parse the central directory contained in `bytes`.
 *
 * Returns `null` when the directory is not fully contained in the window, which
 * lets a caller widen its Range request rather than fail.
 */
export const parseCentralDirectory = (bytes: Uint8Array, windowStart = 0): ZipEntry[] | null => {
  const location = locateCentralDirectory(bytes, windowStart);
  if (location === null) return null;
  const start = location.offset - windowStart;
  if (start < 0 || start + location.size > bytes.byteLength) return null;
  return parseCentralDirectoryEntries(bytes, start, location.entryCount);
};

/** Inflate a deflate-raw payload using the platform's native decompression. */
const inflateRaw = async (data: Uint8Array): Promise<string> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
};

/**
 * A downloaded OOXML package, addressable by part name.
 *
 * Parts are inflated lazily and memoised, because the pivot parts are read more
 * than once while assembling the model and inflating a 175 KB cache definition
 * is not free.
 */
export class OoxmlPackage {
  private readonly view: DataView;
  private readonly entries: Map<string, ZipEntry>;
  private readonly parsed = new Map<string, Document>();
  private readonly text = new Map<string, string>();

  private constructor(
    private readonly bytes: Uint8Array,
    entries: ZipEntry[],
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.entries = new Map(entries.map(entry => [entry.name, entry]));
  }

  /** Parse a complete package held in memory. */
  static open(bytes: Uint8Array): OoxmlPackage {
    const entries = parseCentralDirectory(bytes);
    if (entries === null) {
      throw ToolError.internal(
        'The downloaded workbook is not a readable .xlsx package (no ZIP central directory found).',
      );
    }
    return new OoxmlPackage(bytes, entries);
  }

  /** Every part name in the package. */
  partNames(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Part names matching a pattern, sorted so `pivotTable2` follows `pivotTable1`. */
  matching(pattern: RegExp): string[] {
    return this.partNames()
      .filter(name => pattern.test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  /** Inflate a part to text, or return null when the part is absent. */
  async partText(name: string): Promise<string | null> {
    const cached = this.text.get(name);
    if (cached !== undefined) return cached;

    const entry = this.entries.get(name);
    if (!entry) return null;

    const header = entry.localHeaderOffset;
    const nameLength = this.view.getUint16(header + 26, true);
    const extraLength = this.view.getUint16(header + 28, true);
    const start = header + 30 + nameLength + extraLength;
    const data = this.bytes.subarray(start, start + entry.compressedSize);

    let content: string;
    if (entry.compressionMethod === 0) {
      content = new TextDecoder().decode(data);
    } else if (entry.compressionMethod === 8) {
      content = await inflateRaw(data);
    } else {
      throw ToolError.internal(
        `Workbook part "${name}" uses unsupported ZIP compression method ${entry.compressionMethod}.`,
      );
    }
    this.text.set(name, content);
    return content;
  }

  /** Inflate and XML-parse a part, or return null when the part is absent. */
  async partXml(name: string): Promise<Document | null> {
    const cached = this.parsed.get(name);
    if (cached !== undefined) return cached;

    const content = await this.partText(name);
    if (content === null) return null;

    const doc = new DOMParser().parseFromString(content, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw ToolError.internal(`Workbook part "${name}" is not well-formed XML.`);
    }
    this.parsed.set(name, doc);
    return doc;
  }
}
