import { describe, expect, test } from 'vitest';
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
