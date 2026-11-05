import type { ProgressOptions, ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { hasGraphToken, waitForGraphToken } from './teams-api.js';

/**
 * How often a long step reports its progress again. The platform ends a tool
 * that reports nothing for 25 seconds, and uploading a large file, sharing it
 * with a large chat, or waiting for Teams to renew a token takes longer than that.
 */
const PROGRESS_HEARTBEAT_MS = 10_000;

/** Run one step of a tool, reporting it when it starts and again every PROGRESS_HEARTBEAT_MS until it settles. */
export const runReportedStep = async <T>(
  context: ToolHandlerContext | undefined,
  progress: ProgressOptions,
  step: () => Promise<T>,
): Promise<T> => {
  if (!context) return step();
  context.reportProgress(progress);
  const heartbeat = setInterval(() => context.reportProgress(progress), PROGRESS_HEARTBEAT_MS);
  try {
    return await step();
  } finally {
    clearInterval(heartbeat);
  }
};

/**
 * Resolve once a Microsoft Graph token is captured. Teams mints it about a
 * minute after the page loads, so a call made right after a reload waits for
 * it, reporting progress meanwhile.
 */
export const ensureGraphToken = async (context: ToolHandlerContext | undefined): Promise<void> => {
  if (hasGraphToken()) return;
  await runReportedStep(context, { message: 'Waiting for Teams to renew its Microsoft Graph sign-in' }, () =>
    waitForGraphToken(),
  );
};
