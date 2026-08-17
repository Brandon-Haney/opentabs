import { z } from 'zod';

/**
 * Writing an OPEN deck goes through PowerPoint's co-authoring channel — an
 * incremental revision POSTed to `/pods/PowerPoint.ashx` inside the cross-origin
 * `*.officeapps.live.com` editor frame. Graph's full-file PUT is refused under the
 * co-authoring lock while a human has the deck open, so this is the only path that
 * can change a file mid-session.
 *
 * A tool cannot make the call itself: the adapter runs in the SharePoint host
 * frame, and the endpoint is same-origin only to the editor frame. Instead a tool
 * returns a `__podsAction` directive naming a registered action and its arguments;
 * the platform's pods action engine reads the live model in the editor frame,
 * resolves the target, constructs the revision, writes it with the frame-local
 * donor's live WOPI headers, and confirms it applied. The handler never sees the
 * response; the platform replaces the directive with the engine's parsed result.
 *
 * `podsWrite` remains as the raw escape hatch: a verbatim `{Mode,srs}` body with
 * identity tokens, for decode work and one-off experiments.
 */

/** Substring selecting the PowerPoint editor OOPIF (`<region>-powerpoint.officeapps.live.com`). */
const FRAME_URL_INCLUDES = 'powerpoint.officeapps.live.com';
/** Frame global the pre-script stashes the freshest `/pods` request into, for the auth-header replay. */
const DONOR_GLOBAL = '__otbPptPodsDonor';
/** URL marker the pre-script answers in-frame with the current co-authoring head. */
const HEAD_SENTINEL = '__otb_pods_head__';

/**
 * The `__podsAction` contract version this plugin is built against. The extension
 * rejects a directive newer than it understands with rebuild instructions, so a
 * stale extension build fails loudly instead of no-op'ing.
 */
const PODS_ACTION_VERSION = 1;

/**
 * Placeholder tokens the engine substitutes at write time. One GUID fills the new
 * object (`|1`), the revision (`|2`), the object group (`|3`), and any rewritten
 * reference; the head fills `BaseId` and the top-level `ExpectedLatestId`.
 * Distinctive and JSON-safe, so substituting into the serialized body cannot
 * corrupt real content.
 */
export const PODS_GUID_TOKEN = '__OTB_PODS_GUID__';
export const PODS_HEAD_TOKEN = '__OTB_PODS_HEAD__';

/**
 * The live-model read: a type-2 poll from the zero base. The server answers with
 * the full current `RevisionList` — the load-time base plus every co-authoring
 * revision since — so the engine resolves targets against the LIVE document, not
 * the frozen `openEarly` load snapshot (which is what made edits land on stale
 * object ids and never render).
 */
const MODEL_READ_BODY = JSON.stringify({
  Mode: 4,
  srs: [
    [
      2,
      {
        OperationId: 1,
        DependentOn: 0,
        ExpectedLatestRevisionId: '00000000-0000-0000-0000-000000000000|0',
        SlideId: null,
        Sequence: 0,
        LocalRenderingParams: null,
      },
    ],
  ],
});

/**
 * What the plugin knows about decoded pods failure codes, passed through the
 * directive so the engine can append what-to-do guidance to a failure the agent
 * sees. Keys: `se:<ServerError.Code>/<Source>`, `se:<Code>`, `sc:<StatusCode>`,
 * matched most-specific first.
 */
const PODS_ERROR_HINTS: Record<string, string> = {
  'se:157/2':
    'Code 157/2 means the base revision was superseded (the engine already retried with a fresh head). ' +
    'If it persists, the editor session is likely stale — reload the deck tab and retry.',
  'se:223/3':
    'Code 223/3 means the replayed session request was stale. Reload the deck tab so the editor re-captures ' +
    'a fresh session, then retry.',
};

/**
 * What the agent receives after a raw pods write — not the directive the handler
 * returns, which the platform intercepts and replaces. A write that did not apply
 * comes back as a dispatch error, so a successful result means the revision was
 * accepted (`statusCode: 0`, no conflict).
 */
export const podsWriteOutputSchema = z.object({
  ok: z.boolean().describe('Whether the replayed POST succeeded at the HTTP level.'),
  status: z.number().int().describe('HTTP status of the replayed request.'),
  statusCode: z
    .number()
    .int()
    .optional()
    .describe(
      'The co-authoring StatusCode — 0 means the server ACCEPTED the revision. Acceptance is not application: ' +
        'a revision the server treats as a no-op is accepted and dropped. This raw path does not confirm the ' +
        'document changed; re-read to be certain.',
    ),
  isConflict: z.boolean().optional().describe('Whether the base revision was superseded before the write applied.'),
  head: z.string().optional().describe('The co-authoring head the accepted revision was based on.'),
  retries: z
    .number()
    .int()
    .optional()
    .describe('Extra attempts a stale-base conflict cost (0 when the first POST applied).'),
  frameId: z.number().int().optional().describe('The editor frame the write ran in.'),
  serverError: z
    .object({ code: z.number().int().optional(), source: z.number().int().optional() })
    .optional()
    .describe('The ServerError {Code, Source} pair a rejection carries, when present.'),
  response: z.unknown().optional().describe('The parsed co-authoring response envelope.'),
});

/** The `__podsBridge` directive the platform's raw pods write engine consumes. */
interface PodsBridgeDirective {
  __podsBridge: {
    frameUrlIncludes: string;
    donorGlobal: string;
    headSentinel: string;
    body: Record<string, unknown>;
    guidToken: string;
    headToken: string;
  };
}

/**
 * Build the `__podsBridge` directive for a raw co-authoring revision.
 *
 * `body` is the full `{Mode,srs:[[3,{Revisions:[…]}]]}` envelope with
 * {@link PODS_GUID_TOKEN} and {@link PODS_HEAD_TOKEN} written into its identity
 * slots. The return is typed as the output schema, not the directive, because the
 * platform replaces the directive with the engine's parsed result before the agent
 * sees it — a platform-level transform the type system cannot otherwise express.
 * The cast is localized here so pods tools stay typed against what they receive.
 */
export const podsWrite = (body: Record<string, unknown>): z.infer<typeof podsWriteOutputSchema> => {
  const directive: PodsBridgeDirective = {
    __podsBridge: {
      frameUrlIncludes: FRAME_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      headSentinel: HEAD_SENTINEL,
      body,
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    },
  };
  return directive as unknown as z.infer<typeof podsWriteOutputSchema>;
};

/** The `__podsAction` directive the platform's pods action engine consumes. */
export interface PodsActionDirective {
  __podsAction: {
    v: number;
    action: string;
    args: Record<string, unknown>;
    frameUrlIncludes: string;
    donorGlobal: string;
    headSentinel: string;
    modelReadBody: string;
    dryRun?: boolean;
    guidToken: string;
    headToken: string;
    errorHints: Record<string, string>;
  };
}

/**
 * Build a `__podsAction` directive for one registered engine action. The generic
 * `TOutput` names the schema type the platform's engine result satisfies once it
 * replaces the directive — the same localized-cast convention as {@link podsWrite}.
 */
const podsAction = <TOutput>(action: string, args: Record<string, unknown>, dryRun?: boolean): TOutput => {
  const directive: PodsActionDirective = {
    __podsAction: {
      v: PODS_ACTION_VERSION,
      action,
      args,
      frameUrlIncludes: FRAME_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      headSentinel: HEAD_SENTINEL,
      modelReadBody: MODEL_READ_BODY,
      ...(dryRun !== undefined ? { dryRun } : {}),
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
      errorHints: PODS_ERROR_HINTS,
    },
  };
  return directive as unknown as TOutput;
};

/** The write-result fields every confirmed pods action shares. */
const podsActionResultShape = {
  action: z.string().optional().describe('The engine action that ran.'),
  ok: z.boolean().optional().describe('Whether the replayed POST succeeded at the HTTP level.'),
  status: z.number().int().optional().describe('HTTP status of the replayed write.'),
  statusCode: z
    .number()
    .int()
    .optional()
    .describe('The co-authoring StatusCode — 0 means the server ACCEPTED the revision, not that it applied it.'),
  isConflict: z.boolean().optional().describe('Whether the base revision was superseded before the write applied.'),
  head: z.string().optional().describe('The co-authoring head the accepted revision was based on.'),
  retries: z.number().int().optional().describe('Extra attempts a stale-base conflict cost.'),
  applied: z
    .boolean()
    .optional()
    .describe('Whether the change was OBSERVED in the document after the write — the real proof it landed.'),
  confirmationReads: z.number().int().optional().describe('How many confirmation reads the check took.'),
  frameId: z.number().int().optional().describe('The editor frame the write ran in.'),
  serverError: z
    .object({ code: z.number().int().optional(), source: z.number().int().optional() })
    .optional()
    .describe('The ServerError {Code, Source} pair a rejection carries, when present.'),
  response: z.unknown().optional().describe('The parsed co-authoring response envelope.'),
};

/** What the agent receives after the `set_font_size` engine runs. */
export const podsSetFontSizeOutputSchema = z.object({
  ...podsActionResultShape,
  text: z.string().describe('The paragraph text that was resized.'),
  runId: z.string().describe('The object id of the run that was resized.'),
  oldSizePt: z
    .number()
    .nullable()
    .describe('The font size before the change, in points (null if it could not be read).'),
  newSizePt: z.number().nullable().describe('The font size after the change, in points.'),
});

/**
 * Build the `set_font_size` action directive: resize the run of the paragraph
 * whose visible text is `text` to `sizePt` points.
 */
export const podsSetFontSize = (text: string, sizePt: number): z.infer<typeof podsSetFontSizeOutputSchema> =>
  podsAction('set_font_size', { text, sizePt });

/** What the agent receives after the `format_text` engine runs. */
export const podsFormatTextOutputSchema = z.object({
  ...podsActionResultShape,
  text: z.string().describe('The paragraph text that was formatted.'),
  runId: z.string().describe('The object id of the run that was formatted.'),
  before: z
    .object({
      sizePt: z.number().nullable(),
      bold: z.boolean().nullable(),
      italic: z.boolean().nullable(),
    })
    .describe('The run formatting before the change (null where the run carried no such property).'),
  requested: z
    .object({
      sizePt: z.number().optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      colorHex: z.string().optional(),
      font: z.string().optional(),
    })
    .describe('The changes asked for, echoed back. This is the request — `applied` is the proof of outcome.'),
});

/**
 * Build the `format_text` action directive: change the run formatting (size, bold,
 * italic, underline, colour, and/or font) of the paragraph whose visible text is
 * `text`, live in the open deck. Only the provided attributes change.
 */
export const podsFormatText = (
  text: string,
  changes: { sizePt?: number; bold?: boolean; italic?: boolean; underline?: boolean; colorHex?: string; font?: string },
): z.infer<typeof podsFormatTextOutputSchema> =>
  podsAction('format_text', {
    text,
    ...(changes.sizePt !== undefined ? { sizePt: changes.sizePt } : {}),
    ...(changes.bold !== undefined ? { bold: changes.bold } : {}),
    ...(changes.italic !== undefined ? { italic: changes.italic } : {}),
    ...(changes.underline !== undefined ? { underline: changes.underline } : {}),
    ...(changes.colorHex !== undefined ? { colorHex: changes.colorHex } : {}),
    ...(changes.font !== undefined ? { font: changes.font } : {}),
  });

/** What the agent receives after the `set_text` engine runs. */
export const podsSetTextOutputSchema = z.object({
  ...podsActionResultShape,
  text: z.string().describe('The paragraph text that was replaced.'),
  newText: z.string().describe('The replacement text that was written.'),
  paragraphId: z.string().describe('The object id of the paragraph that was rewritten.'),
  runId: z.string().optional().describe('The run that keeps supplying the formatting.'),
  dryRun: z.boolean().optional().describe('True when this was a dry run (constructed but not written).'),
  body: z.unknown().optional().describe('The constructed revision (dry run only), for inspection.'),
});

/**
 * Build the `set_text` action directive: replace the text of the paragraph whose
 * current visible text is `text` with `newText`, live in the open deck. The
 * paragraph keeps its formatting — the write rewrites the text, not the runs.
 */
export const podsSetText = (text: string, newText: string, dryRun = false): z.infer<typeof podsSetTextOutputSchema> =>
  podsAction('set_text', { text, newText }, dryRun);

/** What the agent receives after the `add_slide` engine runs (write result, or a dry-run body). */
export const podsAddSlideOutputSchema = z.object({
  ...podsActionResultShape,
  layout: z.string().optional().describe('The layout id the new slide was built from.'),
  slideCountBefore: z.number().int().optional().describe('Slide count before the add.'),
  dryRun: z.boolean().optional().describe('True when this was a dry run (constructed but not written).'),
  rootObjectId: z.string().optional(),
  master: z.string().optional(),
  body: z.unknown().optional().describe('The constructed revision (dry run only), for inspection.'),
});

/**
 * Build the `add_slide` action directive: insert a new slide into the open deck
 * live. With `dryRun`, the engine constructs and returns the revision without
 * writing, so a caller can verify it first.
 */
export const podsAddSlide = (dryRun = false): z.infer<typeof podsAddSlideOutputSchema> =>
  podsAction('add_slide', {}, dryRun);

/** What the agent receives after the `delete_slide` engine runs (write result, or a dry-run body). */
export const podsDeleteSlideOutputSchema = z.object({
  ...podsActionResultShape,
  slideIndex: z.number().int().optional().describe('The 1-based position that was deleted.'),
  removedRef: z.string().optional().describe('The reference of the removed slide.'),
  slideCountBefore: z.number().int().optional().describe('Slide count before the delete.'),
  dryRun: z.boolean().optional().describe('True when this was a dry run (constructed but not written).'),
  rootObjectId: z.string().optional(),
  slideRefs: z.array(z.string()).optional().describe('The ordered slide references, so index N can be confirmed.'),
  body: z.unknown().optional().describe('The constructed revision (dry run only), for inspection.'),
});

/**
 * Build the `delete_slide` action directive: remove the slide at 1-based position
 * `slideIndex` from the open deck live. With `dryRun`, the engine constructs and
 * returns the revision (plus the ordered slide references) without writing.
 */
export const podsDeleteSlide = (slideIndex: number, dryRun = false): z.infer<typeof podsDeleteSlideOutputSchema> =>
  podsAction('delete_slide', { slideIndex }, dryRun);

/** What the agent receives after the `read_outline` engine action runs. */
export const podsReadOutlineOutputSchema = z.object({
  action: z.string().optional().describe('The engine action that ran.'),
  slideCount: z.number().int().describe('Slides in the LIVE deck right now.'),
  slideRefs: z.array(z.string()).describe('The ordered slide references, usable as stable slide identities.'),
  paragraphs: z
    .array(
      z.object({
        text: z.string(),
        runs: z.array(
          z.object({
            sizePt: z.number().nullable(),
            bold: z.boolean().nullable(),
            italic: z.boolean().nullable(),
            underline: z.boolean().nullable(),
            colorHex: z.string().nullable(),
            font: z.string().nullable(),
          }),
        ),
      }),
    )
    .describe('Live paragraphs with per-run formatting (null where a run carries no such property).'),
  paragraphTotal: z.number().int().describe('Paragraphs in the live model before capping — compare to array length.'),
  shapes: z.array(z.string()).describe('Shape names in the live model (e.g. "Title 1").'),
  shapeTotal: z.number().int().describe('Shapes in the live model before capping.'),
  totalObjects: z.number().int().describe('Objects in the live model before class filtering.'),
  latestRevisionId: z.string().optional().describe('The co-authoring head the model response reported, when present.'),
});

/** Build the `read_outline` action directive: the live deck reduced to text, formatting, and structure. */
export const podsReadOutline = (): z.infer<typeof podsReadOutlineOutputSchema> => podsAction('read_outline', {});

/** What the agent receives after `open_in_editor` runs. */
export const podsOpenEditorOutputSchema = z.object({
  tabId: z.number().int().describe('The opened tab. Pass this as `tabId` to the live-edit tools to target this deck.'),
  editorReady: z
    .boolean()
    .describe('Whether the editor frame appeared and its co-authoring session went live within the wait.'),
  waitedMs: z.number().int().describe('How long the session took to come up, in milliseconds.'),
  url: z.string().describe('The URL that was opened.'),
});

/** The `__podsOpenEditor` directive the platform consumes. */
interface PodsOpenEditorDirective {
  __podsOpenEditor: {
    url: string;
    frameUrlIncludes: string;
    donorGlobal: string;
    waitMs?: number;
  };
}

/**
 * Build the `__podsOpenEditor` directive: open the deck URL in a new tab and wait
 * for its co-authoring session to be live. The platform allow-lists the URL to
 * Office editor hosts.
 */
export const podsOpenEditor = (url: string, waitMs?: number): z.infer<typeof podsOpenEditorOutputSchema> => {
  const directive: PodsOpenEditorDirective = {
    __podsOpenEditor: {
      url,
      frameUrlIncludes: FRAME_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      ...(waitMs !== undefined ? { waitMs } : {}),
    },
  };
  return directive as unknown as z.infer<typeof podsOpenEditorOutputSchema>;
};
