/**
 * @vitest-environment jsdom
 */
import { describe, expect, test } from 'vitest';
import { readDocumentText } from './docx-text.js';

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
].join(' ');

const documentXml = (body: string): string => `<w:document ${NAMESPACES}><w:body>${body}</w:body></w:document>`;

const run = (text: string, props = ''): string =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;

const para = (...content: string[]): string => `<w:p>${content.join('')}</w:p>`;

const read = (body: string) => readDocumentText({ document: documentXml(body) });

describe('readDocumentText text', () => {
  test('reads tabs, line breaks and entities, and skips field codes', () => {
    const body = para(
      run('Name'),
      '<w:r><w:tab/><w:t>R&amp;D</w:t></w:r>',
      '<w:r><w:br/><w:t>Next line</w:t></w:r>',
      '<w:r><w:instrText> PAGE </w:instrText></w:r>',
    );
    expect(read(body).paragraphs).toEqual(['Name\tR&D\nNext line']);
  });

  test('reads each table row as cells, with no markup leaking into the text', () => {
    const cell = (...paragraphs: string[]) => `<w:tc><w:tcPr><w:tcW w:w="0"/></w:tcPr>${paragraphs.join('')}</w:tc>`;
    const body =
      '<w:tbl><w:tblPr><w:tblW w:w="0"/></w:tblPr><w:tblGrid/>' +
      `<w:tr>${cell(para(run('Step')))}${cell(para(run('Owner')))}</w:tr>` +
      `<w:tr>${cell(para(run('Load')), para(run('Verify')))}${cell(para(run('Ops')))}</w:tr>` +
      '</w:tbl>';
    expect(read(body).paragraphs).toEqual(['| Step | Owner |', '| Load / Verify | Ops |']);
  });

  test('marks headings by the style names in styles.xml, whatever the style id', () => {
    const styles = `<w:styles ${NAMESPACES}><w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style></w:styles>`;
    const document = documentXml(
      `<w:p><w:pPr><w:pStyle w:val="berschrift2"/></w:pPr>${run('Scope')}</w:p>${para(run('Body'))}`,
    );
    expect(readDocumentText({ document, styles }).paragraphs).toEqual(['## Scope', 'Body']);
  });

  test('falls back to heading style ids when the package has no styles part', () => {
    expect(read(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('Title')}</w:p>`).paragraphs).toEqual([
      '# Title',
    ]);
  });

  test('reads content controls and drops empty paragraphs', () => {
    const body = `<w:sdt><w:sdtPr/><w:sdtContent>${para(run('Inside'))}</w:sdtContent></w:sdt>${para()}${para(run('After'))}`;
    expect(read(body).paragraphs).toEqual(['Inside', 'After']);
  });
});

describe('readDocumentText strikethrough', () => {
  test('marks struck text, merging the runs Word splits it into', () => {
    const result = read(para(run('Keep '), run('remove ', '<w:strike/>'), run('this', '<w:strike/>'), run(' end')));
    expect(result.paragraphs).toEqual(['Keep ~~remove this~~ end']);
    expect(result.marks.struck).toBe(1);
  });

  test('treats double strikethrough as struck and w:val="0" or "false" as not struck', () => {
    const result = read(
      para(run('a', '<w:dstrike/>'), run(' b', '<w:strike w:val="0"/>'), run(' c', '<w:strike w:val="false"/>')),
    );
    expect(result.paragraphs).toEqual(['~~a~~ b c']);
  });

  test('leaves struck whitespace unmarked', () => {
    expect(read(para(run('a'), run(' ', '<w:strike/>'), run('b'))).paragraphs).toEqual(['a b']);
  });
});

describe('readDocumentText tracked changes', () => {
  test('marks insertions and deletions, including moved text and struck text inside them', () => {
    const body = para(
      run('Ship on '),
      `<w:del w:id="1" w:author="A"><w:r><w:delText>Monday</w:delText></w:r></w:del>`,
      `<w:ins w:id="2" w:author="A">${run('Friday')}</w:ins>`,
      run('. '),
      `<w:moveFrom w:id="3">${run('Old', '<w:strike/>')}</w:moveFrom>`,
      `<w:moveTo w:id="4">${run('New')}</w:moveTo>`,
    );
    const result = read(body);
    expect(result.paragraphs).toEqual(['Ship on [-Monday-]{+Friday+}. [-~~Old~~-]{+New+}']);
    expect(result.marks).toMatchObject({ insertions: 2, deletions: 2, struck: 1 });
  });

  test('merges one insertion Word stores as several w:ins elements', () => {
    const body = para(`<w:ins w:id="1">${run('two ')}</w:ins>`, `<w:ins w:id="2">${run('parts')}</w:ins>`);
    const result = read(body);
    expect(result.paragraphs).toEqual(['{+two parts+}']);
    expect(result.marks.insertions).toBe(1);
  });
});

describe('readDocumentText images and text boxes', () => {
  const relationships =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId5" Type="image" Target="media/image1.png"/></Relationships>';
  const drawing = (docPr: string) =>
    `<w:r><w:drawing><wp:inline>${docPr}<a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

  test('names an image by its alt text, else its file name', () => {
    const document = documentXml(
      para(run('See '), drawing('<wp:docPr id="1" name="Picture 1" descr="Q3 volume chart"/>')) +
        para(drawing('<wp:docPr id="2" name="Picture 2"/>')),
    );
    const result = readDocumentText({ document, relationships });
    expect(result.paragraphs).toEqual(['See [image: Q3 volume chart]', '[image: image1.png]']);
    expect(result.marks.images).toBe(2);
  });

  test('reads a text box once, from the choice Word renders and not its VML fallback', () => {
    const box = `<w:txbxContent>${para(run('Callout'))}${para(run('second line'))}</w:txbxContent>`;
    const body = para(
      run('Before '),
      `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor>${box}</wp:anchor></w:drawing></mc:Choice>`,
      `<mc:Fallback><w:pict><v:shape><v:textbox>${box}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`,
    );
    expect(read(body).paragraphs).toEqual(['Before [text box: Callout / second line]']);
  });
});

describe('readDocumentText comments', () => {
  const comment = (id: string, author: string, paraId: string, text: string) =>
    `<w:comment w:id="${id}" w:author="${author}" w:date="2026-10-29T14:03:00Z"><w:p w14:paraId="${paraId}"><w:r><w:annotationRef/></w:r>${run(text)}</w:p></w:comment>`;
  const comments = `<w:comments ${NAMESPACES}>${comment('0', 'Dana', 'AAAA0001', 'Is this still in scope?')}${comment('1', 'Lee', 'AAAA0002', 'No, removed.')}${comment('2', 'Dana', 'AAAA0003', 'Typo')}</w:comments>`;
  const commentsExtended = `<w15:commentsEx ${NAMESPACES}><w15:commentEx w15:paraId="AAAA0001" w15:done="1"/><w15:commentEx w15:paraId="AAAA0002" w15:paraIdParent="AAAA0001" w15:done="0"/></w15:commentsEx>`;

  test('anchors each thread where its range starts and lists comments with replies and resolution', () => {
    const document = documentXml(
      para(
        '<w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/>',
        run('Legacy export'),
        '<w:commentRangeEnd w:id="0"/><w:commentRangeEnd w:id="1"/>',
        '<w:r><w:commentReference w:id="0"/></w:r><w:r><w:commentReference w:id="1"/></w:r>',
      ) + para(run('Recieve'), '<w:r><w:commentReference w:id="2"/></w:r>'),
    );
    const result = readDocumentText({ document, comments, commentsExtended });

    expect(result.paragraphs).toEqual(['[COMMENT 0]Legacy export', 'Recieve[COMMENT 2]']);
    expect(result.comments).toEqual([
      {
        id: '0',
        author: 'Dana',
        date: '2026-10-29T14:03:00Z',
        text: 'Is this still in scope?',
        resolved: true,
        reply_to: null,
      },
      { id: '1', author: 'Lee', date: '2026-10-29T14:03:00Z', text: 'No, removed.', resolved: false, reply_to: '0' },
      { id: '2', author: 'Dana', date: '2026-10-29T14:03:00Z', text: 'Typo', resolved: false, reply_to: null },
    ]);
    expect(result.marks.comments).toBe(3);
  });

  test('reads comments as unresolved threads when the package has no commentsExtended part', () => {
    const document = documentXml(para('<w:commentRangeStart w:id="1"/>', run('x')));
    const result = readDocumentText({ document, comments });
    expect(result.paragraphs).toEqual(['[COMMENT 1]x']);
    expect(result.comments.every(c => !c.resolved && c.reply_to === null)).toBe(true);
  });
});

describe('readDocumentText errors', () => {
  test('refuses a part it cannot parse rather than reading it as empty', () => {
    expect(() => readDocumentText({ document: documentXml(para(run('ok'))), comments: '<w:comments' })).toThrow(
      'Could not parse word/comments.xml',
    );
  });
});
