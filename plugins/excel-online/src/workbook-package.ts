import { apiBytes, resolveWorkbookContext } from './excel-api.js';
import { OoxmlPackage, parseCentralDirectory, parseCentralDirectoryFromSuffix } from './ooxml.js';

/**
 * Access to the open workbook's raw `.xlsx` package.
 *
 * The Microsoft Graph workbook API exposes no PivotTable, workbook-connection
 * or pivot-cache surface at any version, so features that need those read the
 * package itself. The package is never cached: a workbook changes whenever
 * Excel autosaves, and serving a stale structure would be worse than the
 * round-trip it saves.
 */

/**
 * Suffix large enough to hold the end-of-central-directory record plus the
 * directory of a workbook with roughly 800 parts. Workbooks past that fall back
 * to a full download rather than issuing a second ranged request, because at
 * that point the directory is a meaningful fraction of the package anyway.
 */
const CENTRAL_DIRECTORY_WINDOW_BYTES = 65_536;

const contentEndpoint = async (): Promise<string> => {
  const ctx = await resolveWorkbookContext();
  return `/drives/${ctx.driveId}/items/${encodeURIComponent(ctx.itemId)}/content`;
};

/** Download and open the complete workbook package. */
export const fetchWorkbookPackage = async (): Promise<OoxmlPackage> => {
  const { bytes } = await apiBytes(await contentEndpoint());
  return OoxmlPackage.open(bytes);
};

/**
 * List the workbook's part names without downloading the whole package.
 *
 * Issues a ranged request for the tail of the file and reads only the ZIP
 * central directory, which holds every part name in plain text. This keeps
 * "does this workbook contain a PivotTable?" cheap on large workbooks. Falls
 * back to a full download when the server ignores the range, when the directory
 * does not fit the window, or for Zip64 archives.
 */
export const fetchWorkbookPartNames = async (): Promise<string[]> => {
  const endpoint = await contentEndpoint();
  const { bytes, isPartial } = await apiBytes(endpoint, { range: `bytes=-${CENTRAL_DIRECTORY_WINDOW_BYTES}` });

  const entries = isPartial ? parseCentralDirectoryFromSuffix(bytes) : parseCentralDirectory(bytes);
  if (entries !== null) return entries.map(entry => entry.name);

  return (await fetchWorkbookPackage()).partNames();
};
