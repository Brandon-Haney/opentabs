import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

export const failingTool = defineTool({
  name: 'failing_tool',
  description:
    'A tool that always fails — calls a server endpoint that returns an error, testing ToolError propagation through the full dispatch stack',
  input: z.object({
    error_code: z
      .string()
      .optional()
      .describe('The error code the server should return (default "deliberate_failure")'),
    error_message: z
      .string()
      .optional()
      .describe('The error message the server should return (default "This tool always fails")'),
  }),
  output: z.object({
    ok: z.boolean().describe('Always false — this tool is designed to fail'),
  }),
  handle: async params => {
    const res = await fetch('/api/fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error_code: params.error_code ?? 'deliberate_failure',
        error_message: params.error_message ?? 'This tool always fails',
      }),
    });

    const data: unknown = await res.json();
    const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};

    // The server always returns { ok: false, error: "...", error_code: "..." }
    // We propagate this as a ToolError, exactly like a real plugin would
    // when the upstream API returns an error (e.g., Slack's "channel_not_found").
    const errorMessage =
      typeof record.error_message === 'string'
        ? record.error_message
        : typeof record.error === 'string'
          ? record.error
          : 'Tool execution failed';
    const errorCode =
      typeof record.error_code === 'string'
        ? record.error_code
        : typeof record.error === 'string'
          ? record.error
          : 'unknown_error';

    throw new ToolError(errorMessage, errorCode);
  },
});
