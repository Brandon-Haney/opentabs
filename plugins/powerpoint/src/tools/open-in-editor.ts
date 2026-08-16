import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { podsOpenEditor, podsOpenEditorOutputSchema } from '../pods-bridge.js';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput } from './schemas.js';

/**
 * Where the editor URL may point. Mirrors the platform-side allow-list (HTTPS +
 * Office editor hosts); checked here too so a bad URL fails fast with a
 * tool-level message instead of a directive rejection.
 */
const isEditorUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host.endsWith('.sharepoint.com') || host === 'powerpoint.cloud.microsoft');
  } catch {
    return false;
  }
};

export const openInEditor = defineTool({
  name: 'open_in_editor',
  displayName: 'Open in Editor',
  description:
    'Open a presentation in the PowerPoint web editor in a new browser tab and wait until its live co-authoring ' +
    'session is ready, so the live-edit tools (`format_text`, `add_slide_live`, `get_live_outline`, …) can target ' +
    'it. This is how a deck that is not open anywhere becomes editable: all editing goes through the co-authoring ' +
    'channel, which needs an open editor. Pass `item_id` (the URL is resolved via an existing-access link, granting ' +
    'no new permissions) or a direct SharePoint `url`. Returns the new `tabId` — pass it to subsequent live tools ' +
    'to target this deck. If `editorReady` comes back false, the editor is still loading; retry a live tool after ' +
    'a few seconds.',
  summary: 'Open a deck in the web editor for live editing',
  icon: 'external-link',
  group: 'Presentations',
  input: z
    .object({
      item_id: z.string().optional().describe('Item ID of the PowerPoint file to open.'),
      drive_id: driveIdInput,
      url: z
        .string()
        .optional()
        .describe('A direct SharePoint /:p:/ or powerpoint.cloud.microsoft URL to open instead of resolving item_id.'),
      wait_seconds: z
        .number()
        .int()
        .min(5)
        .max(180)
        .optional()
        .describe('How long to wait for the editor session before returning (default 60).'),
    })
    .refine(input => input.item_id !== undefined || input.url !== undefined, {
      message: 'Pass item_id (with optional drive_id) or a direct url.',
    }),
  output: podsOpenEditorOutputSchema,
  handle: async params => {
    let url = params.url;
    if (url === undefined) {
      // An existing-access link renders the deck's canonical /:p:/ URL without
      // granting anyone new access. The /:p:/ form matters: the extension's
      // pre-script match patterns cover it, while the raw Doc.aspx webUrl form is
      // rewritten client-side too late for document_start injection.
      const driveId = await requireDriveId(params.drive_id);
      const link = await api<{ link?: { webUrl?: string } }>(`/drives/${driveId}/items/${params.item_id}/createLink`, {
        method: 'POST',
        body: { type: 'edit', scope: 'existingAccess' },
      });
      url = link.link?.webUrl;
      if (!url) {
        throw ToolError.validation(
          'Could not resolve an editor URL for this item — Graph returned no link. Pass `url` directly instead.',
        );
      }
    }
    if (!isEditorUrl(url)) {
      throw ToolError.validation(
        `open_in_editor only opens PowerPoint web URLs (*.sharepoint.com or powerpoint.cloud.microsoft); got "${url}".`,
      );
    }
    return podsOpenEditor(url, params.wait_seconds !== undefined ? params.wait_seconds * 1000 : undefined);
  },
});
