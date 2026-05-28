import { decompressFromUTF16 } from './lz-string.js';

/**
 * Reads the currently open OneNote page from the WAC viewer's local cache.
 *
 * The OneNote web viewer renders pages inside a cross-origin frame, so its DOM
 * and Graph tokens are unreachable from the adapter. But on every page view the
 * viewer writes the rendered page HTML to `localStorage` under an
 * `OneNote_PageSSR_<id>` key (used to fast-boot the page on the next visit). The
 * HTML is compressed with lz-string's UTF-16 codec. This module reads that
 * cache and extracts the page title and text — giving read access to the open
 * page with no Graph token, which matters on SharePoint/OneDrive-hosted
 * notebooks where the page never mints a Notes-scoped token.
 */

const PAGE_SSR_PREFIX = 'OneNote_PageSSR_';

/** Block-level tags whose boundaries become line breaks in extracted text. */
const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'LI',
  'TR',
  'BR',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TABLE',
  'UL',
  'OL',
  'BLOCKQUOTE',
]);

interface RawPageCache {
  PageHtml?: string;
  LastAccessTime?: number | string;
}

interface PageCacheEntry {
  storageKey: string;
  html: string;
  lastAccessTime: number;
}

export interface CurrentPageContent {
  /** Page title with the trailing date/time line removed. */
  title: string;
  /** The page's date/time line, as shown under the title (empty if absent). */
  dateTime: string;
  /** Plain-text page content, with block elements separated by newlines. */
  text: string;
  /** Raw decompressed page HTML — only populated when `format` is `'html'`. */
  html?: string;
}

/** Collect every `OneNote_PageSSR_*` cache entry, newest (most recently accessed) first. */
const collectPageCaches = (): PageCacheEntry[] => {
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return [];
  }

  const entries: PageCacheEntry[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(PAGE_SSR_PREFIX)) continue;

    const raw = storage.getItem(key);
    if (!raw) continue;

    let parsed: RawPageCache;
    try {
      parsed = JSON.parse(raw) as RawPageCache;
    } catch {
      continue;
    }
    if (typeof parsed.PageHtml !== 'string' || parsed.PageHtml.length === 0) continue;

    const html = decompressFromUTF16(parsed.PageHtml);
    if (!html) continue;

    entries.push({ storageKey: key, html, lastAccessTime: Number(parsed.LastAccessTime ?? 0) || 0 });
  }

  return entries.sort((a, b) => b.lastAccessTime - a.lastAccessTime);
};

/** Recursively gather text from a node, inserting newlines at block-element boundaries. */
const collectText = (node: Node, out: string[]): void => {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(child.nodeValue ?? '');
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      collectText(child, out);
      if (BLOCK_TAGS.has((child as Element).tagName)) out.push('\n');
    }
  }
};

const extractText = (root: Element): string =>
  collectTextToString(root)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const collectTextToString = (root: Element): string => {
  const parts: string[] = [];
  collectText(root, parts);
  return parts.join('');
};

/**
 * Returns the currently open OneNote page's content from the local viewer cache,
 * or `null` if no cached page is present (e.g., the page has not finished loading).
 */
export const getCurrentPageContent = (format: 'text' | 'html'): CurrentPageContent | null => {
  const [latest] = collectPageCaches();
  if (!latest) return null;

  const doc = new DOMParser().parseFromString(latest.html, 'text/html');

  const dateTime = doc.querySelector('.TitleDateTimeOutline')?.textContent?.trim() ?? '';
  let title = doc.querySelector('.Title')?.textContent?.trim() ?? '';
  if (dateTime && title.endsWith(dateTime)) title = title.slice(0, -dateTime.length).trim();

  const contentRoot = doc.querySelector('#PageContentContainer') ?? doc.body;
  const text = extractText(contentRoot);

  return {
    title,
    dateTime,
    text,
    ...(format === 'html' ? { html: latest.html } : {}),
  };
};
