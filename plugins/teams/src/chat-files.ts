import type { ChatFileLink, UploadedDriveItem } from './teams-api.js';
import { CHAT_FILES_FOLDER } from './teams-api.js';

/**
 * Files attached to a sent message.
 *
 * Teams does not carry a file in the message. It uploads the file to the
 * sender's OneDrive, into the "Microsoft Teams Chat Files" folder, gives the
 * conversation's members access to it, and sends a message whose
 * `properties.files` — a JSON string — describes the OneDrive item. The
 * message's own text may be empty. The entry's shape below is the one Teams'
 * client sends, captured from files posted from the Teams web app; every value
 * comes from the uploaded item.
 */

const FILE_TYPE = 'http://schema.skype.com/File';

/** A file's extension, lower-cased and without the dot; empty when it has none. */
export const fileExtension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
};

/** The address of a file in the chat-files folder, encoded the way Teams writes it (`%20` for a space). */
export const chatFileUrl = (driveWebUrl: string, name: string): string =>
  `${driveWebUrl.replace(/\/+$/, '')}/${encodeURIComponent(CHAT_FILES_FOLDER)}/${encodeURIComponent(name)}`;

/**
 * The `properties.files` entry describing one uploaded file, with the sharing
 * link that gives the chat's members access when the file was shared.
 */
export const buildFileEntry = (
  item: UploadedDriveItem,
  driveWebUrl: string,
  link: ChatFileLink | null,
): Record<string, unknown> => {
  const uniqueId = item.sharepointIds.listItemUniqueId ?? '';
  const siteUrl = item.sharepointIds.siteUrl ?? '';
  const baseUrl = `${siteUrl.replace(/\/+$/, '')}/`;
  const objectUrl = chatFileUrl(driveWebUrl, item.name);
  const type = fileExtension(item.name);
  return {
    '@type': FILE_TYPE,
    version: 2,
    id: uniqueId,
    itemid: uniqueId,
    baseUrl,
    objectUrl,
    openUrl: null,
    type,
    title: item.name,
    fileName: item.name,
    fileType: type,
    state: 'active',
    providerData: '',
    botFileProperties: {},
    permissionScope: 'SpecificPeople',
    filePreview: { previewUrl: '', previewHeight: 0, previewWidth: 0 },
    fileChicletState: { serviceName: 'p2p', state: 'active' },
    chicletBreadcrumbs: null,
    isUploadError: null,
    progressComplete: null,
    publication: null,
    site: null,
    fileInfo: {
      itemId: item.id,
      fileUrl: objectUrl,
      siteUrl: baseUrl,
      serverRelativeUrl: '',
      shareUrl: link?.shareUrl ?? null,
      shareId: link?.shareId ?? null,
    },
    sharepointIds: {
      ...item.sharepointIds,
      ...(item.parentReference?.driveId ? { driveId: item.parentReference.driveId } : {}),
    },
  };
};

/** Encode bytes as base64, in slices so a large file does not overflow the call stack. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  const SLICE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + SLICE));
  }
  return btoa(binary);
};

/** Decode a base64 string into bytes. */
export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
