import { describe, expect, test } from 'vitest';
import { messagePreview } from './message-preview.js';

describe('messagePreview', () => {
  test('flattens the message HTML to one line of text', () => {
    expect(messagePreview({ content: '<p>Line one<br>line &amp; two</p>\n<p>Next&nbsp;para</p>' })).toBe(
      'Line one line & two Next para',
    );
  });

  test('keeps code indentation, turning each non-breaking space into a plain one', () => {
    expect(messagePreview({ content: '<pre><code>do&nbsp;{<br> &nbsp;&nbsp; $p&nbsp;=&nbsp;0</code></pre>' })).toBe(
      'do {    $p = 0',
    );
  });

  test('leaves out the message the original was itself replying to', () => {
    const content =
      '<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1"><strong>A</strong>' +
      '<p itemprop="preview">older</p></blockquote>\n<p>newer</p>';
    expect(messagePreview({ content })).toBe('newer');
  });

  test('marks each image and each attached file as the Teams client does', () => {
    const files = JSON.stringify([{ title: 'Plan.docx' }]);
    expect(messagePreview({ content: '<p>See this <img src="x" alt="image"></p>', properties: { files } })).toBe(
      'See this 📷 📄 ',
    );
  });

  test('previews a shared file as its link text and one file marker, as Teams wrote it', () => {
    const content =
      '<p><a href="https://x.sharepoint.com/a.docx?d=1&amp;e=2" itemtype="http://schema.skype.com/HyperLink/Files" ' +
      'itemid="EA4A">Plan &amp; Budget.docx</a></p>';
    const files = JSON.stringify([{ title: 'Plan & Budget.docx' }]);
    expect(messagePreview({ content, properties: { files } })).toBe('Plan & Budget.docx 📄 ');
  });

  test('previews a message with nothing to show as a single space', () => {
    expect(messagePreview({ content: '<p> </p>' })).toBe(' ');
  });

  test('cuts a long message short', () => {
    const preview = messagePreview({ content: `<p>${'word '.repeat(100)}</p>` });
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(preview.endsWith('…')).toBe(true);
  });
});
