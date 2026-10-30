import { describe, expect, test, vi } from 'vitest';
import { type AdfNode, adfToMarkdown, markdownToAdf } from './adf.js';

const imageBlock = (ref: string): AdfNode => ({ type: 'mediaSingle', attrs: { ref } });
const resolveAll = { image: (ref: string) => imageBlock(ref) };

describe('markdownToAdf images', () => {
  test('a line holding only an image becomes the resolved block, splitting the paragraph around it', () => {
    const doc = markdownToAdf('Before\n![chart](image:1)\nAfter', resolveAll);
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
      imageBlock('image:1'),
      { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
    ]);
  });

  test('passes the alt text to the resolver and places images inside list items', () => {
    const seen: string[] = [];
    const doc = markdownToAdf('1. Step one\n   ![first step](image:2)', {
      image: (ref, alt) => {
        seen.push(`${ref}|${alt}`);
        return imageBlock(ref);
      },
    });
    expect(seen).toEqual(['image:2|first step']);
    expect(doc.content[0]?.content?.[0]?.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Step one' }] },
      imageBlock('image:2'),
    ]);
  });

  test('leaves an image line as text when there is no resolver or it declines the reference', () => {
    const declined = markdownToAdf('![logo](https://example.com/logo.png)', { image: () => undefined });
    const unresolved = markdownToAdf('![logo](https://example.com/logo.png)');
    for (const doc of [declined, unresolved]) {
      expect(doc.content).toHaveLength(1);
      expect(doc.content[0]?.type).toBe('paragraph');
    }
  });
});

describe('adfToMarkdown media', () => {
  test('reads an embedded image back by its alt text and a file card as [file]', () => {
    const markdown = adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'See below' }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'm1', alt: 'chart.png' } }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'm2' } }] },
        { type: 'mediaGroup', content: [{ type: 'media', attrs: { type: 'file', id: 'm3' } }] },
      ],
    });
    expect(markdown).toBe('See below\n\n[image: chart.png]\n\n[image]\n\n[file]');
  });
});

/** Render the inline nodes as one paragraph. */
const inline = (...content: AdfNode[]): string =>
  adfToMarkdown({ type: 'doc', version: 1, content: [{ type: 'paragraph', content }] });

const text = (value: string): AdfNode => ({ type: 'text', text: value });

const NOV_3_2026 = String(Date.UTC(2026, 10, 3));

describe('adfToMarkdown inline nodes', () => {
  test('reads a date chip as its UTC calendar day, even in a timezone west of UTC', () => {
    vi.stubEnv('TZ', 'America/New_York');
    try {
      expect(new Date(Number(NOV_3_2026)).getDate()).toBe(2);
      expect(inline(text('Migrated by '), { type: 'date', attrs: { timestamp: NOV_3_2026 } }, text('.'))).toBe(
        'Migrated by 2026-11-03.',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('marks a date chip with an unreadable timestamp instead of dropping it', () => {
    expect(inline({ type: 'date', attrs: { timestamp: 'soon' } })).toBe('[unsupported: date]');
    expect(inline({ type: 'date' })).toBe('[unsupported: date]');
  });

  test('reads status lozenges and placeholders by their text', () => {
    expect(inline({ type: 'status', attrs: { text: 'In Progress', color: 'blue' } })).toBe('[status: In Progress]');
    expect(inline({ type: 'placeholder', attrs: { text: 'Add a date' } })).toBe('[placeholder: Add a date]');
  });

  test('reads emoji by text, then short name', () => {
    expect(inline({ type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } })).toBe('😄');
    expect(inline({ type: 'emoji', attrs: { shortName: ':party:', text: '' } })).toBe(':party:');
  });

  test('reads smart links from url or data', () => {
    expect(inline({ type: 'inlineCard', attrs: { url: 'https://example.com/a' } })).toBe('<https://example.com/a>');
    expect(inline({ type: 'inlineCard', attrs: { data: { url: 'https://example.com/b' } } })).toBe(
      '<https://example.com/b>',
    );
    expect(inline({ type: 'inlineCard', attrs: {} })).toBe('[unsupported: inlineCard]');
  });

  test('reads inline media by alt text and type', () => {
    expect(inline({ type: 'mediaInline', attrs: { id: 'm1', alt: 'chart.png', type: 'image' } })).toBe(
      '[image: chart.png]',
    );
    expect(inline({ type: 'mediaInline', attrs: { id: 'm2', type: 'image' } })).toBe('[image]');
    expect(inline({ type: 'mediaInline', attrs: { id: 'm3', type: 'file' } })).toBe('[file]');
  });

  test('names an inline node with no handler', () => {
    expect(inline(text('a '), { type: 'inlineExtension', attrs: {} }, text(' b'))).toBe(
      'a [unsupported: inlineExtension] b',
    );
  });
});

describe('adfToMarkdown block nodes', () => {
  const render = (...content: AdfNode[]): string => adfToMarkdown({ type: 'doc', version: 1, content });

  test('reads task items, with their state and nesting', () => {
    expect(
      render({
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('Built')] },
          {
            type: 'taskItem',
            attrs: { state: 'TODO' },
            content: [text('Migrate by '), { type: 'date', attrs: { timestamp: NOV_3_2026 } }],
          },
          { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'TODO' }, content: [text('Sub-task')] }] },
        ],
      }),
    ).toBe('- [x] Built\n- [ ] Migrate by 2026-11-03\n  - [ ] Sub-task');
  });

  test('reads decision items', () => {
    expect(
      render({
        type: 'decisionList',
        content: [{ type: 'decisionItem', attrs: { state: 'DECIDED' }, content: [text('Ship it')] }],
      }),
    ).toBe('- Decision: Ship it');
  });

  test('reads block and embed cards as links', () => {
    expect(render({ type: 'blockCard', attrs: { url: 'https://example.com/a' } })).toBe('<https://example.com/a>');
    expect(render({ type: 'embedCard', attrs: { url: 'https://example.com/b' } })).toBe('<https://example.com/b>');
    expect(render({ type: 'blockCard', attrs: { datasource: {} } })).toBe('[unsupported: blockCard]');
  });

  test('reads an image caption after the image', () => {
    expect(
      render({
        type: 'mediaSingle',
        content: [
          { type: 'media', attrs: { type: 'file', id: 'm1', alt: 'chart.png' } },
          { type: 'caption', content: [text('Q3 volume')] },
        ],
      }),
    ).toBe('[image: chart.png]\nQ3 volume');
  });

  test('names an empty block with no handler and reads through a container it does not know', () => {
    expect(render({ type: 'extension', attrs: { extensionKey: 'x' } })).toBe('[unsupported: extension]');
    expect(
      render({
        type: 'layoutSection',
        content: [{ type: 'layoutColumn', content: [{ type: 'paragraph', content: [text('Inside')] }] }],
      }),
    ).toBe('Inside');
  });
});
