import { describe, expect, test } from 'vitest';
import { markdownToTeamsHtml } from './markdown-html.js';
import { teamsHtmlToMarkdown } from './teams-markdown.js';

const md = (html: string, names?: Map<string, string>): string => teamsHtmlToMarkdown(html, names).markdown;

const mention = (id: string, text: string): string =>
  `<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="${id}">${text}</span>`;

describe('teamsHtmlToMarkdown', () => {
  test('reads the composer spacer as a blank line, and paragraphs written on consecutive lines as lines', () => {
    expect(md('<p>One</p>\r\n<p>&nbsp;</p>\r\n<p>Two</p>')).toBe('One\n\nTwo');
    expect(md('<p>One</p>\n<p>Two</p>')).toBe('One\nTwo');
    expect(md('<p>Line one<br>line two</p>')).toBe('Line one\nline two');
  });

  test('reads inline formatting, keeping the whitespace at either end outside the marks', () => {
    expect(md('<p><strong>bold </strong>then <i>it</i>, <s>gone</s>, <u>under</u> and <code>a&lt;b</code></p>')).toBe(
      '**bold** then *it*, ~~gone~~, <u>under</u> and `a<b`',
    );
    expect(md('<p><strong><i>both</i></strong></p>')).toBe('***both***');
  });

  test('reads a link as its URL when it shows the URL, and as [text](url) otherwise', () => {
    expect(md('<p><a href="https://x.test/a?b=1&amp;c=2" title="x">https://x.test/a?b=1&amp;c=2</a></p>')).toBe(
      'https://x.test/a?b=1&c=2',
    );
    expect(md('<p>See <a href="https://x.test/plan">the plan</a></p>')).toBe('See [the plan](https://x.test/plan)');
  });

  test('reads mentions as @[Name], joining a name Teams split across spans', () => {
    expect(md(`<p>${mention('0', 'Pat Lee')}&nbsp;- do you have the list?</p>`)).toBe(
      '@[Pat Lee] - do you have the list?',
    );
    expect(md(`<p>${mention('0', 'Ravi')} ${mention('0', 'Kumar')}, thanks</p>`)).toBe('@[Ravi Kumar], thanks');
    expect(md(`<p>${mention('0', 'Sam')} and ${mention('1', 'Dana')}</p>`, new Map([['0', 'Sam Roe']]))).toBe(
      '@[Sam](Sam Roe) and @[Dana]',
    );
  });

  test('leaves the bracketed tags Teams appends out of a mention, which @[...] cannot hold', () => {
    expect(md(`<p>Hi ${mention('0', 'Ravi Kumar [C]')}</p>`, new Map([['0', 'Ravi Kumar [C]']]))).toBe(
      'Hi @[Ravi Kumar]',
    );
    expect(md(`<p>${mention('0', 'Ravi')}</p>`, new Map([['0', 'Ravi Kumar [C]']]))).toBe('@[Ravi](Ravi Kumar)');
  });

  test('reads an emoji as its character and any other image as [image]', () => {
    const emoji =
      '<span class="animated-emoticon-50-idcard" title="ID card" type="(idcard)"><img itemscope="" ' +
      'itemtype="http://schema.skype.com/Emoji" itemid="idcard" src="data:image/png;base64,AAAA" alt="🪪"></span>';
    expect(md(`<p>Badge ${emoji}</p>`)).toBe('Badge 🪪');
    expect(md('<p>Screen: <img src="https://us-api.asm.skype.com/v1/objects/0-x/views/imgo" alt="image"></p>')).toBe(
      'Screen: [image]',
    );
  });

  test('returns the quote card a reply opens with apart from the text', () => {
    const html =
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1793629836726">' +
      '<strong itemprop="mri" itemid="8:orgid:abc">Pat Lee</strong><span itemprop="time" itemid="1793629836726"></span>' +
      '<p itemprop="preview">what else did we need to add</p></blockquote>\n<p>Here is the list.</p>';
    expect(teamsHtmlToMarkdown(html)).toEqual({
      markdown: 'Here is the list.',
      quoted: { id: '1793629836726', author: 'Pat Lee', preview: 'what else did we need to add' },
    });
  });

  test('reads lists, nesting by two spaces and numbering ordered items', () => {
    expect(md('<ul>\n<li>One<ul><li>Sub</li></ul></li><li>Two</li></ul>')).toBe('- One\n  - Sub\n- Two');
    expect(md('<ol><li><p>First</p></li><li>Second</li></ol>')).toBe('1. First\n2. Second');
  });

  test('reads a table as pipe rows with the first row as the header, cells holding paragraphs', () => {
    const html =
      '<table>\r\n<tbody>\r\n<tr>\r\n<td>\r\n<p>Item</p>\r\n</td>\r\n<td>\r\n<p>On hand</p>\r\n</td>\r\n</tr>\r\n' +
      '<tr>\r\n<td>\r\n<p>124-NON</p>\r\n</td>\r\n<td>\r\n<p>1, SALESFLOOR</p>\r\n<p>2, BACKSTOCK</p>\r\n</td>\r\n</tr>\r\n</tbody>\r\n</table>';
    expect(md(html)).toBe('| Item | On hand |\n| --- | --- |\n| 124-NON | 1, SALESFLOOR<br>2, BACKSTOCK |');
  });

  test('reads headings, quotes, rules and code blocks with their language', () => {
    expect(
      md(
        '<h2>Plan</h2><blockquote><p>a<br>b</p></blockquote><hr><pre class="language-sql language-was-manually-selected"><code>select 1;\r\nselect 2;</code></pre>',
      ),
    ).toBe('## Plan\n\n> a\n> b\n\n---\n\n```sql\nselect 1;\nselect 2;\n```');
  });

  test('names composer colours by swatch, and drops a colour off the palette', () => {
    expect(
      md(
        '<p><span style="color:#B6424C">red</span> <span style="background-color:#FDD472; color:inherit">hi</span></p>',
      ),
    ).toBe('<span style="color:red">red</span> <span style="background-color:gold">hi</span>');
    expect(md('<p><span style="color:#123456">plain</span></p>')).toBe('plain');
  });

  test('reads Markdown written by markdownToTeamsHtml back as it was written', () => {
    const samples = [
      'One\n\nTwo\nthree',
      '**Bold**, *italic*, ~~strike~~, `code` and [a link](https://x.test/a)',
      'Intro\n\n- one\n  - nested\n- two\n\nOutro',
      '1. First\n2. Second',
      '# Title\n\nBody',
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
      '> quoted\n> lines',
      '```sql\nselect 1;\n```',
      'Above\n\n---\n\nBelow',
      '<u>under</u> <span style="color:red">red</span> <span style="background-color:gold">marked</span>',
    ];
    for (const sample of samples) expect(md(markdownToTeamsHtml(sample))).toBe(sample);
  });
});
