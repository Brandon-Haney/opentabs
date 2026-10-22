import { describe, expect, test } from 'vitest';
import { base64ToBytes, buildFileEntry, bytesToBase64, chatFileUrl, fileExtension } from './chat-files.js';

const DRIVE = 'https://contoso-my.sharepoint.com/personal/someone_contoso_com/Documents';

describe('chat file entries', () => {
  test('builds the entry Teams sends for a file shared in chat', () => {
    const entry = buildFileEntry(
      {
        id: '01ABCDEF',
        name: 'October 2026.csv',
        sharepointIds: {
          listId: 'list-1',
          listItemUniqueId: 'ec3f71d1-26da-4517-bfb5-259c444be5bd',
          siteId: 'site-1',
          siteUrl: 'https://contoso-my.sharepoint.com/personal/someone_contoso_com',
          webId: 'web-1',
        },
        parentReference: { driveId: 'b!drive' },
      },
      DRIVE,
      null,
    );

    const objectUrl = `${DRIVE}/Microsoft%20Teams%20Chat%20Files/October%202026.csv`;
    expect(entry).toMatchObject({
      '@type': 'http://schema.skype.com/File',
      version: 2,
      id: 'ec3f71d1-26da-4517-bfb5-259c444be5bd',
      itemid: 'ec3f71d1-26da-4517-bfb5-259c444be5bd',
      baseUrl: 'https://contoso-my.sharepoint.com/personal/someone_contoso_com/',
      objectUrl,
      type: 'csv',
      fileType: 'csv',
      title: 'October 2026.csv',
      fileName: 'October 2026.csv',
      state: 'active',
      permissionScope: 'SpecificPeople',
      fileChicletState: { serviceName: 'p2p', state: 'active' },
      fileInfo: {
        itemId: '01ABCDEF',
        fileUrl: objectUrl,
        siteUrl: 'https://contoso-my.sharepoint.com/personal/someone_contoso_com/',
        serverRelativeUrl: '',
        shareUrl: null,
        shareId: null,
      },
      sharepointIds: { listId: 'list-1', listItemUniqueId: 'ec3f71d1-26da-4517-bfb5-259c444be5bd', driveId: 'b!drive' },
    });
  });

  test('records the sharing link that gives the chat access, as Teams does', () => {
    const entry = buildFileEntry({ id: '01ABCDEF', name: 'a.xlsx', sharepointIds: {} }, DRIVE, {
      shareUrl: 'https://contoso-my.sharepoint.com/:x:/g/personal/x',
      shareId: 'd2c1e24e-988d-485a-a917-96b7df94c680',
    });
    expect(entry.fileInfo).toMatchObject({
      shareUrl: 'https://contoso-my.sharepoint.com/:x:/g/personal/x',
      shareId: 'd2c1e24e-988d-485a-a917-96b7df94c680',
    });
  });

  test('encodes the address the way Teams writes it', () => {
    expect(chatFileUrl(`${DRIVE}/`, 'a & b #1.pdf')).toBe(
      `${DRIVE}/Microsoft%20Teams%20Chat%20Files/a%20%26%20b%20%231.pdf`,
    );
  });

  test('takes the extension in lower case, and none from a dotfile or a trailing dot', () => {
    expect(fileExtension('Report.XLSX')).toBe('xlsx');
    expect(fileExtension('.env')).toBe('');
    expect(fileExtension('notes.')).toBe('');
  });

  test('decodes base64 into bytes', () => {
    expect([...base64ToBytes('AAEC/w==')]).toEqual([0, 1, 2, 255]);
  });

  test('encodes bytes as base64', () => {
    expect(bytesToBase64(new Uint8Array([0, 1, 2, 255]))).toBe('AAEC/w==');
  });

  test('round-trips bytes larger than one encoding slice', () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 7 }, (_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
