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
 * builds the `{Mode,srs}` revision body — with two placeholder tokens where the
 * write-time identity values go — and returns the {@link podsWrite} directive. The
 * platform's pods engine reads the live head, mints a client GUID, substitutes
 * both, and replays the POST in the editor frame with the frame-local donor's live
 * WOPI headers. The handler never sees the response; the platform replaces the
 * directive with the parsed result.
 */

/** Substring selecting the PowerPoint editor OOPIF (`<region>-powerpoint.officeapps.live.com`). */
const FRAME_URL_INCLUDES = 'powerpoint.officeapps.live.com';
/** Frame global the pre-script stashes the freshest `/pods` request into, for the auth-header replay. */
const DONOR_GLOBAL = '__otbPptPodsDonor';
/** URL marker the pre-script answers in-frame with the current co-authoring head. */
const HEAD_SENTINEL = '__otb_pods_head__';

/**
 * Placeholder tokens the tool writes into the body's identity slots; the engine
 * substitutes them at write time. One GUID fills the run object (`|1`), the
 * revision (`|2`), the object group (`|3`), and the rewritten target run-reference;
 * the head fills `BaseId` and the top-level `ExpectedLatestId`. Distinctive and
 * JSON-safe, so substituting into the serialized body cannot corrupt real content.
 */
export const PODS_GUID_TOKEN = '__OTB_PODS_GUID__';
export const PODS_HEAD_TOKEN = '__OTB_PODS_HEAD__';

/**
 * What the agent receives after the pods engine runs — not the directive the
 * handler returns, which the platform intercepts and replaces. A write that did
 * not apply comes back as a dispatch error, so a successful result means the
 * revision was accepted (`statusCode: 0`, no conflict).
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
  response: z.unknown().optional().describe('The parsed co-authoring response envelope.'),
});

/** The `__podsBridge` directive the platform's pods engine consumes. */
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
 * Build the `__podsBridge` directive for a co-authoring revision.
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

/**
 * The live-model read: a type-2 poll from the zero base. The server answers with
 * the full current `RevisionList` — the load-time base plus every co-authoring
 * revision since — so the engine resolves targets against the LIVE document, not
 * the frozen `openEarly` load snapshot (which is what made edits land on stale
 * object ids and never render). The engine sends this as the request body of the
 * in-frame replay and reconstructs the current model latest-wins per object id.
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

/** What the agent receives after the `set_font_size` engine runs. */
export const podsSetFontSizeOutputSchema = z.object({
  ok: z.boolean().describe('Whether the replayed POST succeeded at the HTTP level.'),
  status: z.number().int().describe('HTTP status of the replayed write.'),
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
    .describe('Whether the new size was OBSERVED on the run after the write — the real proof it landed.'),
  confirmationReads: z.number().int().optional().describe('How many confirmation reads the check took.'),
  text: z.string().describe('The paragraph text that was resized.'),
  runId: z.string().describe('The object id of the run that was resized.'),
  oldSizePt: z
    .number()
    .nullable()
    .describe('The font size before the change, in points (null if it could not be read).'),
  newSizePt: z.number().describe('The font size after the change, in points.'),
});

/** The `__podsSetFontSize` directive the platform's resize engine consumes. */
interface PodsSetFontSizeDirective {
  __podsSetFontSize: {
    frameUrlIncludes: string;
    donorGlobal: string;
    headSentinel: string;
    text: string;
    sizePt: number;
    modelReadBody: string;
    guidToken: string;
    headToken: string;
  };
}

/**
 * Build the `__podsSetFontSize` directive: resize the run of the paragraph whose
 * visible text is `text` to `sizePt` points. The engine reads the live model to
 * resolve the paragraph and its run, constructs the revision, and writes it — the
 * tool cannot pre-build the body because the ids are per-session. The return is
 * typed as the output schema for the same reason as {@link podsWrite}: the platform
 * replaces the directive with the engine's result before the agent sees it.
 */
export const podsSetFontSize = (text: string, sizePt: number): z.infer<typeof podsSetFontSizeOutputSchema> => {
  const directive: PodsSetFontSizeDirective = {
    __podsSetFontSize: {
      frameUrlIncludes: FRAME_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      headSentinel: HEAD_SENTINEL,
      text,
      sizePt,
      modelReadBody: MODEL_READ_BODY,
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    },
  };
  return directive as unknown as z.infer<typeof podsSetFontSizeOutputSchema>;
};

/** What the agent receives after the `format_text` engine runs. */
export const podsFormatTextOutputSchema = z.object({
  ok: z.boolean().describe('Whether the replayed POST succeeded at the HTTP level.'),
  status: z.number().int().describe('HTTP status of the replayed write.'),
  statusCode: z.number().int().optional().describe('The co-authoring StatusCode — 0 means the change was applied.'),
  isConflict: z.boolean().optional().describe('Whether the base revision was superseded before the write applied.'),
  head: z.string().optional().describe('The co-authoring head the accepted revision was based on.'),
  retries: z.number().int().optional().describe('Extra attempts a stale-base conflict cost.'),
  applied: z
    .boolean()
    .optional()
    .describe('Whether the change was OBSERVED in the document after the write — the real proof it landed.'),
  confirmationReads: z.number().int().optional().describe('How many confirmation reads the check took.'),
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

/** The `__podsFormatText` directive the platform's run-format engine consumes. */
interface PodsFormatTextDirective {
  __podsFormatText: {
    frameUrlIncludes: string;
    donorGlobal: string;
    headSentinel: string;
    text: string;
    sizePt?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    colorHex?: string;
    font?: string;
    modelReadBody: string;
    guidToken: string;
    headToken: string;
  };
}

/**
 * Build the `__podsFormatText` directive: change the run formatting (size, bold,
 * italic, underline, colour, and/or font) of the paragraph whose visible text is
 * `text`, live in the open deck. Generalizes {@link podsSetFontSize}; only the
 * provided attributes change. The return is typed as the output schema for the same
 * reason as {@link podsWrite}: the platform replaces the directive with the engine's
 * result before the agent sees it.
 */
export const podsFormatText = (
  text: string,
  changes: { sizePt?: number; bold?: boolean; italic?: boolean; underline?: boolean; colorHex?: string; font?: string },
): z.infer<typeof podsFormatTextOutputSchema> => {
  const directive: PodsFormatTextDirective = {
    __podsFormatText: {
      frameUrlIncludes: FRAME_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      headSentinel: HEAD_SENTINEL,
      text,
      ...(changes.sizePt !== undefined ? { sizePt: changes.sizePt } : {}),
      ...(changes.bold !== undefined ? { bold: changes.bold } : {}),
      ...(changes.italic !== undefined ? { italic: changes.italic } : {}),
      ...(changes.underline !== undefined ? { underline: changes.underline } : {}),
      ...(changes.colorHex !== undefined ? { colorHex: changes.colorHex } : {}),
      ...(changes.font !== undefined ? { font: changes.font } : {}),
      modelReadBody: MODEL_READ_BODY,
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    },
  };
  return directive as unknown as z.infer<typeof podsFormatTextOutputSchema>;
};

/** What the agent receives after the `add_slide` engine runs (write result, or a dry-run body). */
export const podsAddSlideOutputSchema = z.object({
  ok: z.boolean().optional().describe('Whether the replayed POST succeeded at the HTTP level.'),
  status: z.number().int().optional().describe('HTTP status of the replayed write.'),
  statusCode: z
    .number()
    .int()
    .optional()
    .describe('The co-authoring StatusCode — 0 means the server ACCEPTED the revision, not that it applied it.'),
  isConflict: z.boolean().optional(),
  head: z.string().optional(),
  retries: z.number().int().optional(),
  applied: z
    .boolean()
    .optional()
    .describe('Whether the slide list was OBSERVED to grow after the write — the real proof the slide was added.'),
  confirmationReads: z.number().int().optional().describe('How many confirmation reads the check took.'),
  layout: z.string().optional().describe('The layout id the new slide was built from.'),
  slideCountBefore: z.number().int().optional().describe('Slide count before the add.'),
  dryRun: z.boolean().optional().describe('True when this was a dry run (constructed but not written).'),
  rootObjectId: z.string().optional(),
  master: z.string().optional(),
  body: z.unknown().optional().describe('The constructed revision (dry run only), for inspection.'),
});

/** The `__podsAddSlide` directive the platform's add-slide engine consumes. */
interface PodsAddSlideDirective {
  __podsAddSlide: {
    frameUrlIncludes: string;
    donorGlobal: string;
    headSentinel: string;
    modelReadBody: string;
    dryRun: boolean;
    guidToken: string;
    headToken: string;
  };
}

/**
 * Build the `__podsAddSlide` directive: insert a new slide into the open deck live.
 * The engine reads the live root and a template slide's layout, constructs the
 * `NewSlideWithLayout` revision, and writes it. With `dryRun`, it constructs and
 * returns the revision without writing, so a caller can verify it first.
 */
export const podsAddSlide = (dryRun = false): z.infer<typeof podsAddSlideOutputSchema> => {
  const directive: PodsAddSlideDirective = {
    __podsAddSlide: {
      frameUrlIncludes: FRAME_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      headSentinel: HEAD_SENTINEL,
      modelReadBody: MODEL_READ_BODY,
      dryRun,
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    },
  };
  return directive as unknown as z.infer<typeof podsAddSlideOutputSchema>;
};

/** What the agent receives after the `delete_slide` engine runs (write result, or a dry-run body). */
export const podsDeleteSlideOutputSchema = z.object({
  ok: z.boolean().optional().describe('Whether the replayed POST succeeded at the HTTP level.'),
  status: z.number().int().optional().describe('HTTP status of the replayed write.'),
  statusCode: z
    .number()
    .int()
    .optional()
    .describe('The co-authoring StatusCode — 0 means the server ACCEPTED the revision, not that it applied it.'),
  isConflict: z.boolean().optional(),
  head: z.string().optional(),
  retries: z.number().int().optional(),
  applied: z
    .boolean()
    .optional()
    .describe("Whether the slide's reference was OBSERVED to be gone after the write — the real proof it was deleted."),
  confirmationReads: z.number().int().optional().describe('How many confirmation reads the check took.'),
  slideIndex: z.number().int().optional().describe('The 1-based position that was deleted.'),
  removedRef: z.string().optional().describe('The reference of the removed slide.'),
  slideCountBefore: z.number().int().optional().describe('Slide count before the delete.'),
  dryRun: z.boolean().optional().describe('True when this was a dry run (constructed but not written).'),
  rootObjectId: z.string().optional(),
  slideRefs: z.array(z.string()).optional().describe('The ordered slide references, so index N can be confirmed.'),
  body: z.unknown().optional().describe('The constructed revision (dry run only), for inspection.'),
});

/** The `__podsDeleteSlide` directive the platform's delete-slide engine consumes. */
interface PodsDeleteSlideDirective {
  __podsDeleteSlide: {
    frameUrlIncludes: string;
    donorGlobal: string;
    headSentinel: string;
    modelReadBody: string;
    slideIndex: number;
    dryRun: boolean;
    guidToken: string;
    headToken: string;
  };
}

/**
 * Build the `__podsDeleteSlide` directive: remove the slide at 1-based position
 * `slideIndex` from the open deck live. The engine reads the live root, drops the
 * target reference from the slide list, constructs the `DeleteSlide` revision, and
 * writes it. With `dryRun`, it constructs and returns the revision (plus the ordered
 * slide references) without writing, so a caller can confirm which slide index N is.
 */
export const podsDeleteSlide = (slideIndex: number, dryRun = false): z.infer<typeof podsDeleteSlideOutputSchema> => {
  const directive: PodsDeleteSlideDirective = {
    __podsDeleteSlide: {
      frameUrlIncludes: FRAME_URL_INCLUDES,
      donorGlobal: DONOR_GLOBAL,
      headSentinel: HEAD_SENTINEL,
      modelReadBody: MODEL_READ_BODY,
      slideIndex,
      dryRun,
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    },
  };
  return directive as unknown as z.infer<typeof podsDeleteSlideOutputSchema>;
};
