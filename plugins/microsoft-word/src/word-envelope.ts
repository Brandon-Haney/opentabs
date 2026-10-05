/**
 * Completing a Word co-authoring request from the editor's live session.
 *
 * Every request on Word's channel names the open file through a `FileId` that
 * embeds a WOPI access token, alongside the Cobalt session identifiers the
 * server routes by. Those values exist only in the editor frame, so a request
 * built outside it — the platform's live reads and edits — carries
 * {@link WORD_ENVELOPE_FLAG} instead, and the pre-script completes it from the
 * editor's own most recent poll before it is sent. The token never leaves the
 * frame. The extension's `word-live-model.ts` sets the same flag.
 */

/** Flag on a request entry (`srs[i][1]`) asking for completion from the live session. */
export const WORD_ENVELOPE_FLAG = '__otbWordEnvelope';

/** The session identifiers every channel request repeats, copied verbatim from the editor's latest poll. */
const WORD_SESSION_KEYS = [
  'LocalCobaltSessionId',
  'LocalCobaltMachineId',
  'LocalCobaltClusterId',
  'LocalCobaltSessionHasBackup',
  'WaciiEnabledRequests',
  'SettingsRoutedToServer',
  'LineageId',
] as const;

/** Whether a request body asks for completion. */
export const isFlaggedWordRequest = (body: string): boolean => body.includes(WORD_ENVELOPE_FLAG);

/**
 * Complete every flagged entry of a channel request from the editor's latest
 * poll entry, returning the body unchanged when nothing is flagged.
 *
 * A flagged poll (type 2) is the editor's poll with the flagged fields laid over
 * it, so a live read differs from the editor's own poll only in what it asks
 * for. A flagged write (type 3) gets the session identifiers and its revision's
 * `FileId`; everything else in it is the caller's. Throws when there is no poll
 * to complete from: without its session the server refuses the request anyway,
 * and the reason would be lost.
 */
export const completeWordEnvelope = (body: string, poll: Record<string, unknown> | null): string => {
  if (!isFlaggedWordRequest(body)) return body;
  const parsed = JSON.parse(body) as { srs?: [number, Record<string, unknown>][] };
  if (!Array.isArray(parsed.srs)) return body;
  if (!poll) {
    throw new Error(
      'The Word editor has not polled its co-authoring channel yet, so there is no live session to write through. ' +
        'Wait for the document to finish opening, then retry.',
    );
  }
  const session: Record<string, unknown> = {};
  for (const key of WORD_SESSION_KEYS) if (key in poll) session[key] = poll[key];

  parsed.srs = parsed.srs.map(([type, entry]) => {
    if (!entry || entry[WORD_ENVELOPE_FLAG] !== true) return [type, entry];
    const { [WORD_ENVELOPE_FLAG]: _flag, ...own } = entry;
    if (type === 2) return [type, { ...poll, ...own }];
    const revision = own.Revision as Record<string, unknown> | undefined;
    return [
      type,
      {
        OperationId: own.OperationId,
        DependentOn: own.DependentOn,
        ...session,
        ...own,
        ...(revision ? { Revision: { ...revision, FileId: poll.FileId } } : {}),
      },
    ];
  });
  return JSON.stringify(parsed);
};
