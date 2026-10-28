import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { blankWorkbookBytes } from '../blank-xlsx.js';
import { api } from '../excel-api.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** File name with the `.xlsx` extension appended when the caller left it off. */
const workbookFileName = (name: string): string => (/\.xlsx$/i.test(name) ? name : `${name}.xlsx`);

/** OneDrive-root-relative path, each segment URL-encoded, for Graph path addressing. */
const encodeDrivePath = (folder: string | undefined, fileName: string): string =>
  [...(folder ?? '').split('/'), fileName]
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
    .map(encodeURIComponent)
    .join('/');

interface CreatedItem {
  id?: string;
  name?: string;
  webUrl?: string;
  parentReference?: { driveId?: string };
  sharepointIds?: { siteUrl?: string; listItemUniqueId?: string };
}

/**
 * The workbook's address in the `/:x:/r/<site>/_layouts/15/Doc.aspx` form the
 * Excel editor itself uses, which is the form the Excel plugin's tab match
 * patterns recognise; the raw webUrl opens the same editor under an address
 * they do not. Falls back to the webUrl outside SharePoint (personal
 * OneDrive), whose items carry no SharePoint ids.
 */
export const workbookEditorUrl = (item: CreatedItem): string => {
  const siteUrl = item.sharepointIds?.siteUrl;
  const uniqueId = item.sharepointIds?.listItemUniqueId;
  if (!siteUrl || !uniqueId || !item.name) return item.webUrl ?? '';
  const site = new URL(siteUrl);
  const query = `sourcedoc=%7B${uniqueId}%7D&file=${encodeURIComponent(item.name)}&action=default`;
  return `${site.origin}/:x:/r${site.pathname.replace(/\/+$/, '')}/_layouts/15/Doc.aspx?${query}`;
};

export const createWorkbook = defineTool({
  name: 'create_workbook',
  displayName: 'Create Workbook',
  description:
    'Create a new blank workbook (one empty sheet named Sheet1) in your OneDrive, like File → New → Blank ' +
    'workbook. Fails rather than overwrite when a file of that name already exists in the folder. Every other ' +
    'tool acts on the workbook open in the tab, so open the returned editor_url (browser_open_tab) to work in ' +
    'the new workbook.',
  summary: 'Create a new blank workbook in OneDrive',
  icon: 'file-plus',
  group: 'Workbook',
  input: z.object({
    name: z.string().trim().min(1).describe('File name; ".xlsx" is appended when missing'),
    folder: z
      .string()
      .optional()
      .describe('Folder path from the root of your OneDrive, e.g. "Reports/2026" (default: the root, "My files")'),
  }),
  output: z.object({
    workbook: z.object({
      drive_id: z.string().describe('OneDrive drive ID'),
      item_id: z.string().describe('Workbook item ID'),
      name: z.string().describe('Workbook file name'),
      editor_url: z.string().describe('URL that opens the workbook in Excel for the web'),
    }),
  }),
  handle: async params => {
    const fileName = workbookFileName(params.name);
    const path = encodeDrivePath(params.folder, fileName);

    // conflictBehavior=fail makes Graph answer 409 instead of replacing an
    // existing file. That also makes the PUT unsafe to replay — a hidden
    // success would come back as a conflict — so it is not marked idempotent.
    let item: CreatedItem;
    try {
      item = await api<CreatedItem>(`/me/drive/root:/${path}:/content?@microsoft.graph.conflictBehavior=fail`, {
        method: 'PUT',
        rawBody: { data: new Blob([blankWorkbookBytes()], { type: XLSX_MIME }), contentType: XLSX_MIME },
      });
    } catch (error: unknown) {
      if (error instanceof ToolError && error.details?.httpStatus === 409) {
        throw ToolError.validation(
          `A file named "${fileName}" already exists in ${params.folder ? `"${params.folder}"` : 'the OneDrive root'}. ` +
            'Choose another name.',
        );
      }
      throw error;
    }

    // The upload response omits SharePoint ids, so they are read back. The file
    // exists from here on: a failed read still reports it, with the raw webUrl.
    const located = await api<CreatedItem>(`/drives/${item.parentReference?.driveId ?? ''}/items/${item.id ?? ''}`, {
      query: { $select: 'id,name,webUrl,parentReference,sharepointIds' },
    }).catch(() => item);

    return {
      workbook: {
        drive_id: item.parentReference?.driveId ?? '',
        item_id: item.id ?? '',
        name: item.name ?? fileName,
        editor_url: workbookEditorUrl(located),
      },
    };
  },
});
