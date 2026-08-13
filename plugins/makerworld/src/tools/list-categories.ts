import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';

/** A node in MakerWorld's category tree. Leaves are what a model is filed under. */
interface RawCategory {
  id?: number;
  name?: string;
  slug?: string;
  children?: RawCategory[];
}

interface FlatCategory {
  id: number;
  name: string;
  slug: string;
  parent: string;
  assignable: boolean;
}

/**
 * Flatten the tree depth-first, so a caller reading the list top to bottom sees
 * each section's children directly beneath it.
 *
 * MakerWorld wraps everything in an unnamed root whose children are the
 * top-level sections; the root is dropped and its children are reported with an
 * empty parent.
 */
const flatten = (node: RawCategory, parent: string, into: FlatCategory[]): void => {
  const children = node.children ?? [];
  const name = node.name ?? '';

  if (node.id !== undefined && name.length > 0) {
    into.push({
      id: node.id,
      name,
      slug: node.slug ?? '',
      parent,
      assignable: children.length === 0,
    });
  }

  for (const child of children) {
    flatten(child, name, into);
  }
};

export const listCategories = defineTool({
  name: 'list_categories',
  displayName: 'List Categories',
  description:
    'List the categories a model can be filed under, flattened from the section tree MakerWorld browses by. Call it to get a valid category_id before upload_model rather than guessing a number. Only leaf categories are assignable — the eleven top-level sections exist to group them and are returned with assignable false. Category is the strongest single lever on where a model surfaces, since it decides which browse pages and filters it appears in at all, so it is worth checking an existing model is in the right one when diagnosing weak impressions.',
  summary: 'List categories a model can be filed under',
  icon: 'folder-tree',
  group: 'Reference',
  input: z.object({
    search: z
      .string()
      .optional()
      .describe('Case-insensitive filter on category and section name. Omit to return the whole tree.'),
    assignable_only: z
      .boolean()
      .optional()
      .describe('Return only categories a model can actually be filed under (default false)'),
  }),
  output: z.object({
    categories: z
      .array(
        z.object({
          id: z.number().describe('Category ID — this is what upload_model takes as category_id'),
          name: z.string().describe('Category name'),
          slug: z.string().describe('URL slug MakerWorld browses this category by'),
          parent: z.string().describe('Section this category sits under, empty for the top-level sections'),
          assignable: z.boolean().describe('Whether a model can be filed under it, which only leaves can be'),
        }),
      )
      .describe('Categories, each section followed by its own children'),
    count: z.number().describe('Number of categories returned'),
  }),
  handle: async params => {
    const root = await api<RawCategory>('design-service', '/design/category');

    const all: FlatCategory[] = [];
    flatten(root, '', all);

    const needle = params.search?.trim().toLowerCase();
    const categories = all.filter(category => {
      if (params.assignable_only === true && !category.assignable) return false;
      if (needle === undefined || needle.length === 0) return true;
      return category.name.toLowerCase().includes(needle) || category.parent.toLowerCase().includes(needle);
    });

    return { categories, count: categories.length };
  },
});
