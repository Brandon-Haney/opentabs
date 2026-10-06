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
