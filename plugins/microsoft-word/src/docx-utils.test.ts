import { describe, expect, test } from 'vitest';
import { replaceTextInXml } from './docx-utils.js';

const run = (text: string, attrs = ''): string => `<w:r><w:t${attrs}>${text}</w:t></w:r>`;

describe('replaceTextInXml', () => {
  test('replaces every occurrence within text elements and counts them', () => {
    const xml = `<w:p>${run('Draft plan, draft two')}${run('Draft', ' xml:space="preserve"')}</w:p>`;

    expect(replaceTextInXml(xml, 'Draft', 'Final')).toEqual({
      xml: `<w:p>${run('Final plan, draft two')}${run('Final', ' xml:space="preserve"')}</w:p>`,
      count: 2,
    });
  });

  test('leaves the markup between a tab, a table or a row and the next text untouched', () => {
    const xml =
      '<w:p><w:r><w:tab/></w:r>' +
      run('w:p tab') +
      '</w:p><w:tbl><w:tr><w:tc><w:p>' +
      run('cell') +
      '</w:p></w:tc></w:tr></w:tbl>';

    const { xml: out, count } = replaceTextInXml(xml, 'w', 'X');

    expect(count).toBe(1);
    expect(out).toBe(xml.replace('w:p tab', 'X:p tab'));
  });

  test('matches characters written as references, and writes the result escaped', () => {
    const xml = run('Don&apos;t move &#8220;A &amp; B&#8221;');

    expect(replaceTextInXml(xml, "Don't move “A & B”", 'Keep <A & B>')).toEqual({
      xml: run('Keep &lt;A &amp; B&gt;'),
      count: 1,
    });
  });

  test('keeps the outer spaces of replaced text, marking the element to preserve them', () => {
    expect(replaceTextInXml(run('Total:X'), 'X', ' 12 ').xml).toBe(run('Total: 12 ', ' xml:space="preserve"'));
  });

  test('leaves deleted tracked text alone', () => {
    const xml = '<w:del><w:r><w:delText>old</w:delText></w:r></w:del>';

    expect(replaceTextInXml(xml, 'old', 'new')).toEqual({ xml, count: 0 });
  });
});
