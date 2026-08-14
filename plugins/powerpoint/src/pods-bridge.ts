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
    .describe('The co-authoring StatusCode — 0 means the revision was accepted and applied.'),
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
