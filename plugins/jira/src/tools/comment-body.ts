import { ToolError } from '@opentabs-dev/plugin-sdk';
import { type AdfDoc, type AdfNode, markdownToAdf } from './adf.js';

export interface CommentBodyInput {
  body?: string;
  body_adf?: Record<string, unknown>;
}

/** Image and file blocks a comment body can show besides its own content. */
export interface CommentMedia {
  /** Blocks for the images passed in `images`, in order. A body places the Nth with `![alt](image:N)`. */
  added: AdfNode[];
  /** Images the comment already shows, in order. A body places the Nth with `![alt](existing:N)`. */
  existing?: AdfNode[];
  /** File cards the comment already shows; they follow a markdown body. */
  files?: AdfNode[];
}

const isAdfDoc = (value: unknown): value is AdfDoc => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.type === 'doc' && Array.isArray(v.content);
};

/** A markdown image reference: `image:N` for the Nth added image, `existing:N` for the Nth the comment shows. */
const IMAGE_REF = /^(image|existing):(\d+)$/;

/**
 * Build the comment document. Markdown lines `![alt](image:N)` and
 * `![alt](existing:N)` place an image there. Images the body does not place
 * follow it, existing ones first, then the comment's file cards. A `body_adf`
 * document is the whole comment: only the added images follow it.
 */
export const buildCommentDoc = (input: CommentBodyInput, media: CommentMedia): AdfDoc => {
  const existing = media.existing ?? [];
  if (input.body_adf !== undefined) {
    if (!isAdfDoc(input.body_adf)) {
      throw ToolError.validation('body_adf must be an ADF document: { type: "doc", version: 1, content: [...] }.');
    }
    return media.added.length
      ? { ...input.body_adf, content: [...input.body_adf.content, ...media.added] }
      : input.body_adf;
  }

  const placed = { image: new Set<number>(), existing: new Set<number>() };
  const doc: AdfDoc =
    input.body === undefined || input.body.trim() === ''
      ? { type: 'doc', version: 1, content: [] }
      : markdownToAdf(input.body, {
          image: ref => {
            const m = IMAGE_REF.exec(ref);
            if (!m?.[1] || !m[2]) return undefined;
            const kind = m[1] as keyof typeof placed;
            const blocks = kind === 'image' ? media.added : existing;
            const index = Number(m[2]) - 1;
            const block = blocks[index];
            if (!block) {
              throw ToolError.validation(
                kind === 'image'
                  ? `The body places ![…](${ref}), but ${blocks.length} image(s) were passed in \`images\`.`
                  : `The body places ![…](${ref}), but the comment shows ${blocks.length} image(s).`,
              );
            }
            placed[kind].add(index);
            return block;
          },
        });
  const following = [
    ...existing.filter((_, index) => !placed.existing.has(index)),
    ...(media.files ?? []),
    ...media.added.filter((_, index) => !placed.image.has(index)),
  ];
  return following.length ? { ...doc, content: [...doc.content, ...following] } : doc;
};

/** The images (`mediaSingle`) and file cards (`mediaGroup`) a comment shows, in document order. */
export const commentMediaBlocks = (body: unknown): { existing: AdfNode[]; files: AdfNode[] } => {
  const existing: AdfNode[] = [];
  const files: AdfNode[] = [];
  const walk = (nodes: AdfNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (node.type === 'mediaSingle') existing.push(node);
      else if (node.type === 'mediaGroup') files.push(node);
      else walk(node.content);
    }
  };
  walk(isAdfDoc(body) ? body.content : undefined);
  return { existing, files };
};
