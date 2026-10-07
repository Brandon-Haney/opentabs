import { describe, expect, test } from 'vitest';
import { extractMessageImages, imageExtension, parseAmsImageUrl } from './ams-image.js';

const ID = '0-eus-d12-bf12d4332cc5aee85b51ee9917594a8a';
const FULL = `https://us-api.asm.skype.com/v1/objects/${ID}/views/imgpsh_fullsize_anim`;

describe('parseAmsImageUrl', () => {
  test('maps the inline preview view to the full-size view', () => {
    expect(parseAmsImageUrl(`https://us-api.asm.skype.com/v1/objects/${ID}/views/imgo`)).toEqual({
      objectId: ID,
      fullSizeUrl: FULL,
    });
  });

  test('accepts the bare object URL and other regions', () => {
    expect(parseAmsImageUrl(`https://eu-api.asm.skype.com/v1/objects/${ID}/`)?.fullSizeUrl).toBe(
      `https://eu-api.asm.skype.com/v1/objects/${ID}/views/imgpsh_fullsize_anim`,
    );
  });

  test('rejects URLs outside the Teams media service', () => {
    expect(parseAmsImageUrl('https://example.com/v1/objects/abc/views/imgo')).toBeNull();
    expect(parseAmsImageUrl('http://us-api.asm.skype.com/v1/objects/abc/views/imgo')).toBeNull();
    expect(parseAmsImageUrl('not a url')).toBeNull();
  });
});

describe('extractMessageImages', () => {
  test('finds each AMS image once, in order, ignoring other images', () => {
    const html =
      `<p><img src="https://us-api.asm.skype.com/v1/objects/${ID}/views/imgo" itemtype="http://schema.skype.com/AMSImage" width="800"></p>` +
      '<img src="https://statics.teams.cdn.office.net/emoji.png">' +
      `<img alt="again" src="https://us-api.asm.skype.com/v1/objects/${ID}/views/imgo">` +
      '<img src="https://us-api.asm.skype.com/v1/objects/0-wus-other/views/imgo">';
    expect(extractMessageImages(html)).toEqual([
      { objectId: ID, fullSizeUrl: FULL },
      {
        objectId: '0-wus-other',
        fullSizeUrl: 'https://us-api.asm.skype.com/v1/objects/0-wus-other/views/imgpsh_fullsize_anim',
      },
    ]);
  });

  test('returns nothing for a message without images', () => {
    expect(extractMessageImages('<p>No images here</p>')).toEqual([]);
  });
});

describe('imageExtension', () => {
  test('maps image MIME types to extensions', () => {
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/gif')).toBe('gif');
    expect(imageExtension('application/octet-stream')).toBe('img');
  });
});
