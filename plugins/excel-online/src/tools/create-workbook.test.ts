import { describe, expect, it } from 'vitest';
import { workbookEditorUrl } from './create-workbook.js';

describe('workbookEditorUrl', () => {
  it('builds the /:x:/r Doc.aspx address from the SharePoint ids', () => {
    expect(
      workbookEditorUrl({
        name: 'Q4 Plan.xlsx',
        webUrl: 'https://contoso-my.sharepoint.com/personal/megan_contoso_com/Documents/Q4%20Plan.xlsx',
        sharepointIds: {
          siteUrl: 'https://contoso-my.sharepoint.com/personal/megan_contoso_com/',
          listItemUniqueId: '94f70960-fb31-4b53-a01f-75c9620ec4e0',
        },
      }),
    ).toBe(
      'https://contoso-my.sharepoint.com/:x:/r/personal/megan_contoso_com/_layouts/15/Doc.aspx' +
        '?sourcedoc=%7B94f70960-fb31-4b53-a01f-75c9620ec4e0%7D&file=Q4%20Plan.xlsx&action=default',
    );
  });

  it('falls back to the webUrl when the item has no SharePoint ids', () => {
    expect(workbookEditorUrl({ name: 'Book.xlsx', webUrl: 'https://onedrive.live.com/edit?id=ABC' })).toBe(
      'https://onedrive.live.com/edit?id=ABC',
    );
  });

  it('returns an empty string when Graph reported no address at all', () => {
    expect(workbookEditorUrl({})).toBe('');
  });
});
