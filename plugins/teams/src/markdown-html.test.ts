import { describe, expect, test } from 'vitest';
import { markdownToTeamsHtml } from './markdown-html.js';

describe('markdownToTeamsHtml paragraph spacing', () => {
  test('a blank line between paragraphs emits the composer spacer', () => {
    expect(markdownToTeamsHtml('One\n\nTwo')).toBe('<p>One</p>\n<p>&nbsp;</p>\n<p>Two</p>');
  });

  test('a blank line before a bold header line emits a spacer', () => {
    expect(markdownToTeamsHtml('One\n\n**Header**')).toBe('<p>One</p>\n<p>&nbsp;</p>\n<p><strong>Header</strong></p>');
  });

  test('a blank line between a heading and a paragraph emits a spacer', () => {
    expect(markdownToTeamsHtml('# Title\n\nBody')).toBe('<h1>Title</h1>\n<p>&nbsp;</p>\n<p>Body</p>');
    expect(markdownToTeamsHtml('Body\n\n## Next')).toBe('<p>Body</p>\n<p>&nbsp;</p>\n<h2>Next</h2>');
  });

  test('a heading directly followed by text emits no spacer', () => {
    expect(markdownToTeamsHtml('# Title\nBody')).toBe('<h1>Title</h1>\n<p>Body</p>');
  });

  test('several blank lines collapse to one spacer', () => {
    expect(markdownToTeamsHtml('One\n\n\n\nTwo')).toBe('<p>One</p>\n<p>&nbsp;</p>\n<p>Two</p>');
  });

  test('soft line breaks stay inside one paragraph', () => {
    expect(markdownToTeamsHtml('One\nTwo')).toBe('<p>One<br>Two</p>');
  });

  test('lists keep their own margin and get no spacer', () => {
    expect(markdownToTeamsHtml('Intro\n\n- a\n- b\n\nOutro')).toBe(
      '<p>Intro</p>\n<ul><li>a</li><li>b</li></ul>\n<p>Outro</p>',
    );
  });

  test('a blank line on either side of a table emits a spacer', () => {
    expect(markdownToTeamsHtml('One\n\n| a |\n| - |\n| 1 |\n\nTwo')).toBe(
      '<p>One</p>\n<p>&nbsp;</p>\n<table><tbody><tr><td><p>a</p></td></tr><tr><td><p>1</p></td></tr></tbody></table>\n<p>&nbsp;</p>\n<p>Two</p>',
    );
  });

  test('blocks with their own margin get no spacer', () => {
    expect(markdownToTeamsHtml('One\n\n> quoted\n\nTwo')).toBe(
      '<p>One</p>\n<blockquote><p>quoted</p></blockquote>\n<p>Two</p>',
    );
    expect(markdownToTeamsHtml('One\n\n---\n\nTwo')).toBe('<p>One</p>\n<hr>\n<p>Two</p>');
  });
});

describe('markdownToTeamsHtml lists', () => {
  test('blank lines between bullets keep one list', () => {
    expect(markdownToTeamsHtml('- a\n\n- b\n\n\n- c')).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
  });

  test('blank lines between numbered items keep one list', () => {
    expect(markdownToTeamsHtml('1. a\n\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  test('a list of the other kind after a blank line starts a new list', () => {
    expect(markdownToTeamsHtml('- a\n\n1. b')).toBe('<ul><li>a</li></ul>\n<ol><li>b</li></ol>');
  });

  test('trailing blank lines end the list', () => {
    expect(markdownToTeamsHtml('- a\n\n')).toBe('<ul><li>a</li></ul>');
  });
});

describe('markdownToTeamsHtml character references', () => {
  test('&nbsp; passes through instead of being escaped', () => {
    expect(markdownToTeamsHtml('a&nbsp;b')).toBe('<p>a&nbsp;b</p>');
  });

  test('a line holding only &nbsp; becomes an author-written spacer', () => {
    expect(markdownToTeamsHtml('One\n&nbsp;\nTwo')).toBe('<p>One<br>&nbsp;<br>Two</p>');
  });

  test('numeric references pass through', () => {
    expect(markdownToTeamsHtml('a&#8212;b&#x2014;c')).toBe('<p>a&#8212;b&#x2014;c</p>');
  });

  test('a bare ampersand is still escaped', () => {
    expect(markdownToTeamsHtml('R&D & ops')).toBe('<p>R&amp;D &amp; ops</p>');
  });

  test('references inside code stay literal', () => {
    expect(markdownToTeamsHtml('`&nbsp;`')).toBe('<p><code>&amp;nbsp;</code></p>');
    expect(markdownToTeamsHtml('```\n&nbsp;\n```')).toBe(
      '<pre class="language-plaintext"><code>&amp;nbsp;</code></pre>',
    );
  });
});

describe('markdownToTeamsHtml nested lists', () => {
  test('an indented bullet nests inside the item above it', () => {
    expect(markdownToTeamsHtml('- Parent\n  - Child\n- Sibling')).toBe(
      '<ul><li>Parent<ul><li>Child</li></ul></li><li>Sibling</li></ul>',
    );
  });

  test('an indented numbered item nests inside a numbered item', () => {
    expect(markdownToTeamsHtml('1. Parent\n   1. Child')).toBe('<ol><li>Parent<ol><li>Child</li></ol></li></ol>');
  });

  test('a nested list may be of the other kind', () => {
    expect(markdownToTeamsHtml('1. Step\n   - Detail\n2. Next')).toBe(
      '<ol><li>Step<ul><li>Detail</li></ul></li><li>Next</li></ol>',
    );
  });

  test('lists nest several levels and return to the outer level', () => {
    expect(markdownToTeamsHtml('- a\n  - b\n    - c\n- d')).toBe(
      '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>',
    );
  });

  test('a tab nests like spaces', () => {
    expect(markdownToTeamsHtml('- a\n\t- b')).toBe('<ul><li>a<ul><li>b</li></ul></li></ul>');
  });

  test('blank lines inside a nested list keep it whole', () => {
    expect(markdownToTeamsHtml('- a\n\n  - b\n\n- c')).toBe('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  });
});

describe('markdownToTeamsHtml paragraph indent', () => {
  test('four leading spaces or a tab indent a paragraph one level', () => {
    expect(markdownToTeamsHtml('    Indented')).toBe('<p style="margin-left:40px;">Indented</p>');
    expect(markdownToTeamsHtml('\tIndented')).toBe('<p style="margin-left:40px;">Indented</p>');
  });

  test('each further four columns adds a level', () => {
    expect(markdownToTeamsHtml('        Twice')).toBe('<p style="margin-left:80px;">Twice</p>');
  });

  test('fewer than four leading spaces do not indent', () => {
    expect(markdownToTeamsHtml('  Not indented')).toBe('<p>Not indented</p>');
  });

  test('an indented paragraph still gets a spacer after a blank line', () => {
    expect(markdownToTeamsHtml('One\n\n    Two')).toBe(
      '<p>One</p>\n<p>&nbsp;</p>\n<p style="margin-left:40px;">Two</p>',
    );
  });
});

describe('markdownToTeamsHtml code block languages', () => {
  test('a picker language is stored as the composer stores it', () => {
    expect(markdownToTeamsHtml('```sql\nselect 1\n```')).toBe(
      '<pre class="language-sql language-was-manually-selected"><code>select 1</code></pre>',
    );
  });

  test('aliases map to the picker id', () => {
    expect(markdownToTeamsHtml('```c#\nx\n```')).toContain('class="language-csharp ');
    expect(markdownToTeamsHtml('```C++\nx\n```')).toContain('class="language-cpp ');
    expect(markdownToTeamsHtml('```sh\nx\n```')).toContain('class="language-bash ');
    expect(markdownToTeamsHtml('```Dockerfile\nx\n```')).toContain('class="language-dockerFile ');
  });

  test('a missing or unknown language is plain text', () => {
    expect(markdownToTeamsHtml('```\nx\n```')).toBe('<pre class="language-plaintext"><code>x</code></pre>');
    expect(markdownToTeamsHtml('```cobol\nx\n```')).toBe('<pre class="language-plaintext"><code>x</code></pre>');
    expect(markdownToTeamsHtml('```constructor\nx\n```')).toBe('<pre class="language-plaintext"><code>x</code></pre>');
  });
});
