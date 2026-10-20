/**
 * Removing hyperlinks from an OPEN Word document through the pods engine, as the
 * editor's Remove Link does (captured 2026-10-20; see "Hyperlinks and the
 * Hyperlink character style" in `plugins/microsoft-word/docs/live-document-model.md`).
 *
 * A hyperlink is a field: placeholder characters around the link text, each its
 * own run pointing at a field-character object, the first carrying the
 * `HYPERLINK "…"` code. Remove Link drops those placeholders from the paragraph's
 * text and runs, and points the link text at a format without the Hyperlink
 * character style and with the in-field flags off — so the text stays and stops
 * being, and looking like, a link.
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';
import type { PodsMint, PodsWriteActionSpec } from './pods-actions.js';
import {
  findPresentationRoot,
  type PodsModel,
  type PodsObject,
  PROP_TEXT,
  readProp,
  refToObjectId,
} from './pods-model.js';
import { PROP_ROOT_NEW_FORMATS } from './word-formatting.js';
import {
  buildWordRevisionBody,
  findUniqueParagraph,
  listWordParagraphs,
  PROP_CHARACTER_STYLE,
  PROP_RUN_BOUNDARIES,
  PROP_RUN_FORMATS,
  paragraphAtIndex,
  RUN_FLAG_PROPS,
  RUN_LIST_PROPS,
  WORD_CLASS_CHAR_FORMAT,
  WORD_CLASS_PARAGRAPH,
  WORD_STRUCTURE_CLASSES,
  type WordParagraph,
  type WordWriteObject,
  withProperty,
  wordCellIdOf,
} from './word-live-model.js';

/** A field character; a run pointing at one is a field's placeholder, not text. */
const WORD_CLASS_FIELD_CHARACTER = 131073;
const PROP_FIELD_CHARACTER_KIND = 335559696;
/** The field character that separates a field's code from its displayed result. */
const FIELD_SEPARATOR = '16';
const FIELD_END = '17';
const PROP_FIELD_CODE = 469777596;
/** Flags a character format carries while its text sits inside a field, and inside its result. */
const PROP_IN_FIELD = 134225428;
const PROP_IN_FIELD_RESULT = 134225433;
const PROP_FORMAT_SET = 335560228;
const PROP_LANGUAGE_HINT = 201342000;

/** One run of a paragraph, as removing links sees it. */
interface Run {
  text: string;
  /** Index into the paragraph's per-run arrays. */
  run: number;
  /** The run is a placeholder of a link field and goes away. */
  drop: boolean;
  /** The run is the displayed text of a link that goes away. */
  linkText: boolean;
}

/** A link in a paragraph: its address and displayed text. */
export interface LinkFound {
  address: string;
  text: string;
}

const lookup = (model: PodsModel, ref: string | undefined): PodsObject | undefined => {
  const id = ref ? refToObjectId(ref) : null;
  return id ? model.objects.find(o => o.objectId === id) : undefined;
};

/**
 * Split a paragraph into runs and mark the links whose displayed text contains
 * `find` (every link when `find` is absent) for removal. Fields other than
 * hyperlinks are left whole.
 */
export const markLinks = (
  model: PodsModel,
  properties: (string | number)[],
  find: string | undefined,
): { runs: Run[]; removed: LinkFound[] } => {
  const text = readProp(properties, PROP_TEXT) ?? '';
  const boundaries = (readProp(properties, PROP_RUN_BOUNDARIES) ?? '').split(',').filter(Boolean).map(Number);
  const refs = (readProp(properties, PROP_RUN_FORMATS) ?? '').split(',');
  const starts = [0, ...boundaries];
  const runs: Run[] = starts.map((start, run) => ({
    text: text.slice(start, boundaries[run] ?? text.length),
    run,
    drop: false,
    linkText: false,
  }));

  const removed: LinkFound[] = [];
  let field: { address: string; members: Run[]; resultText: string; inResult: boolean } | undefined;
  for (const run of runs) {
    const character = lookup(model, refs[run.run]);
    if (character?.classId !== WORD_CLASS_FIELD_CHARACTER) {
      if (field) {
        field.members.push(run);
        if (field.inResult) field.resultText += run.text;
      }
      continue;
    }
    const code = readProp(character.properties, PROP_FIELD_CODE);
    const kind = readProp(character.properties, PROP_FIELD_CHARACTER_KIND);
    if (!field) {
      const address = code === undefined ? undefined : /^\s*HYPERLINK\s+"([^"]*)"/i.exec(code)?.[1];
      if (address === undefined) continue;
      field = { address, members: [run], resultText: '', inResult: false };
      continue;
    }
    field.members.push(run);
    if (kind === FIELD_SEPARATOR) field.inResult = true;
    if (kind !== FIELD_END) continue;
    if (find === undefined || field.resultText.includes(find)) {
      removed.push({ address: field.address, text: field.resultText });
      let inResult = false;
      for (const member of field.members) {
        const memberKind = readProp(lookup(model, refs[member.run])?.properties ?? [], PROP_FIELD_CHARACTER_KIND);
        const isCharacter = lookup(model, refs[member.run])?.classId === WORD_CLASS_FIELD_CHARACTER;
        if (isCharacter) {
          member.drop = true;
          if (memberKind === FIELD_SEPARATOR) inResult = true;
        } else if (inResult) {
          member.linkText = true;
        } else {
          member.drop = true;
        }
      }
    }
    field = undefined;
  }
  return { runs, removed };
};

/** A paragraph's properties with the marked runs dropped and the link text pointed at `remap(ref)`. */
export const withoutLinks = (
  properties: (string | number)[],
  runs: Run[],
  remap: (ref: string) => string,
): { properties: (string | number)[]; text: string } => {
  const runCount = runs.length;
  const kept = runs.filter(run => !run.drop && run.text.length > 0);
  const text = kept.map(run => run.text).join('');
  const boundaries: number[] = [];
  let offset = 0;
  kept.forEach((run, i) => {
    if (i > 0) boundaries.push(offset);
    offset += run.text.length;
  });

  const rewritten: (string | number)[] = [];
  let wroteBoundaries = false;
  for (let i = 0; i + 1 < properties.length; i += 2) {
    const key = properties[i];
    const value = properties[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === PROP_TEXT) {
      rewritten.push(key, text);
    } else if (key === PROP_RUN_BOUNDARIES) {
      if (boundaries.length > 0) rewritten.push(key, boundaries.join(','));
      wroteBoundaries = true;
    } else if (
      typeof key === 'number' &&
      RUN_FLAG_PROPS.includes(key) &&
      typeof value === 'string' &&
      value.length === runCount
    ) {
      rewritten.push(key, kept.map(run => value[run.run]).join(''));
    } else if (typeof key === 'number' && RUN_LIST_PROPS.includes(key) && typeof value === 'string') {
      const entries = value.split(',');
      if (entries.length !== runCount) {
        rewritten.push(key, value);
        continue;
      }
      rewritten.push(
        key,
        kept
          .map(run => {
            const entry = entries[run.run] as string;
            return key === PROP_RUN_FORMATS && run.linkText ? remap(entry) : entry;
          })
          .join(','),
      );
    } else {
      rewritten.push(key, value);
    }
  }
  if (!wroteBoundaries && boundaries.length > 0) rewritten.push(PROP_RUN_BOUNDARIES, boundaries.join(','));
  return { properties: rewritten, text };
};

/** The format link text takes once its link is removed: its own, without the link style, out of the field. */
export const unlinkedFormat = (base: (string | number)[]): (string | number)[] => {
  let properties: (string | number)[] = [];
  for (let i = 0; i + 1 < base.length; i += 2) {
    if (base[i] !== PROP_CHARACTER_STYLE) properties.push(base[i] as string | number, base[i + 1] as string | number);
  }
  properties = withProperty(properties, PROP_IN_FIELD, 'false');
  properties = withProperty(properties, PROP_IN_FIELD_RESULT, 'false');
  properties = withProperty(properties, PROP_FORMAT_SET, '1');
  if (readProp(properties, PROP_LANGUAGE_HINT) === undefined) properties.push(PROP_LANGUAGE_HINT, '0');
  return properties;
};

export interface WordRemoveLinkArgs {
  /** Text the link displays; absent to remove every link in the paragraph. */
  find?: string;
  index?: number;
  anchor?: string;
}

interface LinkTarget {
  paragraph: WordParagraph;
  runs: Run[];
  removed: LinkFound[];
}

export interface WordRemoveLinkContext {
  targets: LinkTarget[];
  cellId: string;
  root: PodsObject;
  /** The current properties of each format a link's text uses, by reference. */
  bases: Map<string, (string | number)[]>;
}

const resolveRemoveLink = (model: PodsModel, args: WordRemoveLinkArgs): WordRemoveLinkContext => {
  const all = listWordParagraphs(model);
  const scope =
    args.index !== undefined
      ? [paragraphAtIndex(all, args.index)]
      : args.anchor !== undefined
        ? [findUniqueParagraph(all, args.anchor, 'paragraph to remove links from')]
        : all;
  const targets = scope
    .map(paragraph => ({ paragraph, ...markLinks(model, paragraph.paragraph.properties, args.find) }))
    .filter(t => t.removed.length > 0);
  if (targets.length === 0) {
    throw new FrameBridgeValidationError(
      args.find === undefined
        ? 'The paragraph has no links.'
        : `No link displaying "${args.find}" was found${scope.length === 1 ? ' in the paragraph' : ''}.`,
    );
  }
  const links = targets.reduce((sum, t) => sum + t.removed.length, 0);
  if (args.index === undefined && args.anchor === undefined && links > 1) {
    throw new FrameBridgeValidationError(
      `${links} links display "${args.find}" (paragraphs ${targets.map(t => `#${t.paragraph.index}`).join(', ')}). ` +
        'Name the paragraph with index or anchor to remove the links in it.',
    );
  }
  const cells = new Set(targets.map(t => wordCellIdOf(model, t.paragraph.paragraph)));
  if (cells.size > 1) {
    throw new FrameBridgeValidationError('The links lie in more than one storage cell; remove them one at a time.');
  }

  const bases = new Map<string, (string | number)[]>();
  for (const target of targets) {
    const refs = (readProp(target.paragraph.paragraph.properties, PROP_RUN_FORMATS) ?? '').split(',');
    for (const run of target.runs) {
      const ref = refs[run.run] ?? '';
      if (!run.linkText || bases.has(ref)) continue;
      const format = lookup(model, ref);
      bases.set(ref, format?.classId === WORD_CLASS_CHAR_FORMAT ? format.properties : []);
    }
  }
  return { targets, cellId: [...cells][0] as string, root: findPresentationRoot(model), bases };
};

const buildRemoveLinkBody = (
  ctx: WordRemoveLinkContext,
  _args: WordRemoveLinkArgs,
  mint: PodsMint,
): Record<string, unknown> => {
  const formats = new Map<string, { ref: string; object: WordWriteObject }>();
  let slot = 3;
  for (const [baseRef, base] of ctx.bases) {
    formats.set(baseRef, {
      ref: `{${mint.guidToken}}{${slot}}`,
      object: {
        ObjectId: `${mint.guidToken}|${slot}`,
        ClassId: WORD_CLASS_CHAR_FORMAT,
        Properties: unlinkedFormat(base),
      },
    });
    slot += 1;
  }
  const paragraphs = ctx.targets.map(t => ({
    ObjectId: t.paragraph.paragraph.objectId,
    ClassId: WORD_CLASS_PARAGRAPH,
    Properties: withoutLinks(t.paragraph.paragraph.properties, t.runs, ref => formats.get(ref)?.ref ?? ref).properties,
  }));
  const listed = readProp(ctx.root.properties, PROP_ROOT_NEW_FORMATS);
  const root: WordWriteObject = {
    ObjectId: ctx.root.objectId,
    ClassId: ctx.root.classId,
    Properties: withProperty(
      ctx.root.properties,
      PROP_ROOT_NEW_FORMATS,
      [listed, ...[...formats.values()].map(f => f.ref)].filter(Boolean).join(','),
    ),
  };
  return buildWordRevisionBody(
    [root, ...paragraphs, ...[...formats.values()].map(f => f.object)],
    ctx.cellId,
    mint.guidToken,
    mint.headToken,
  );
};

/** The `word_remove_link` action: remove hyperlinks, keeping their text. */
export const wordRemoveLinkAction: PodsWriteActionSpec<WordRemoveLinkArgs, WordRemoveLinkContext> = {
  kind: 'write',
  classFilter: [...WORD_STRUCTURE_CLASSES, WORD_CLASS_CHAR_FORMAT, WORD_CLASS_FIELD_CHARACTER],
  parseArgs: raw => {
    const action = 'word_remove_link';
    const string = (key: string): string | undefined => {
      const value = raw[key];
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value.length === 0) {
        throw new FrameBridgeValidationError(`${action} \`${key}\` must be a non-empty string.`);
      }
      return value;
    };
    const index = raw.index;
    if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || index < 1)) {
      throw new FrameBridgeValidationError(`${action} \`index\` must be a positive integer.`);
    }
    const args: WordRemoveLinkArgs = {
      find: string('find'),
      index: index as number | undefined,
      anchor: index === undefined ? string('anchor') : undefined,
    };
    if (args.find === undefined && args.index === undefined && args.anchor === undefined) {
      throw new FrameBridgeValidationError(`${action} needs \`find\` (the link text), or a paragraph (index/anchor).`);
    }
    return args;
  },
  resolve: resolveRemoveLink,
  build: buildRemoveLinkBody,
  /** Applied when each target paragraph (found by its id) reads as the text with the links' placeholders gone. */
  isApplied: (model, first) =>
    first.targets.every(t => {
      const paragraph = model.objects.find(o => o.objectId === t.paragraph.paragraph.objectId);
      const expected = withoutLinks(t.paragraph.paragraph.properties, t.runs, ref => ref).text;
      return paragraph !== undefined && readProp(paragraph.properties, PROP_TEXT) === expected;
    }),
  // Once applied the links are gone, so a re-issue would fail to resolve.
  idempotent: false,
  compactDryRun: true,
  summarize: ctx => ({
    removed: ctx.targets.flatMap(t => t.removed.map(link => ({ index: t.paragraph.index, ...link }))),
  }),
  dryRunExtras: ctx => ({
    removed: ctx.targets.flatMap(t => t.removed.map(link => ({ index: t.paragraph.index, ...link }))),
  }),
};
