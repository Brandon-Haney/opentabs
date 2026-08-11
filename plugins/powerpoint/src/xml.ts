/**
 * Shared XML plumbing for the OOXML parts inside a PPTX package.
 *
 * OOXML producers vary the namespace *prefix* they bind to a given namespace
 * URI, and Microsoft's newer schemas (comments, change tracking) introduce
 * prefixes that no published parser hardcodes. Every helper here therefore
 * matches on `localName` rather than a qualified name, which is stable across
 * producers.
 */

import { ToolError } from '@opentabs-dev/plugin-sdk';

const xmlParser = typeof DOMParser !== 'undefined' ? new DOMParser() : undefined;
const xmlSerializer = typeof XMLSerializer !== 'undefined' ? new XMLSerializer() : undefined;

export const parseXml = (xml: string): Document => {
  if (!xmlParser) throw ToolError.internal('DOMParser not available');
  return xmlParser.parseFromString(xml, 'application/xml');
};

export const serializeXml = (doc: Document): string => {
  if (!xmlSerializer) throw ToolError.internal('XMLSerializer not available');
  return xmlSerializer.serializeToString(doc);
};

export const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

export const getLocalName = (node: Node): string | undefined => (isElement(node) ? node.localName : undefined);

/** Direct child elements, in document order. */
export const childElements = (el: Element): Element[] => {
  const out: Element[] = [];
  for (const n of el.childNodes) if (isElement(n)) out.push(n);
  return out;
};

/**
 * The first *direct child* with this local name.
 *
 * Prefer this over a subtree search whenever a schema nests an element of the
 * same name deeper down — `CT_Comment`, for instance, holds both its own
 * `txBody` and one `txBody` per reply, so a descendant search returns the
 * wrong text.
 */
export const childByLocalName = (el: Element, localName: string): Element | undefined =>
  childElements(el).find(c => c.localName === localName);

/** Every element in the subtree, in document order, excluding `root` itself. */
export const descendantElements = (root: Document | Element): Element[] => {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const out: Element[] = [];
  let node = walker.nextNode();
  while (node) {
    if (isElement(node)) out.push(node);
    node = walker.nextNode();
  }
  return out;
};

/** Every element in the subtree with this local name, in document order. */
export const descendantsByLocalName = (root: Document | Element, localName: string): Element[] =>
  descendantElements(root).filter(el => el.localName === localName);

/** The first element in the subtree with this local name, without walking the rest. */
export const firstDescendantByLocalName = (root: Document | Element, localName: string): Element | undefined => {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (isElement(node) && node.localName === localName) return node;
    node = walker.nextNode();
  }
  return undefined;
};
