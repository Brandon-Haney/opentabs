/**
 * Permission bypass detection — determined once at startup.
 *
 * The --dangerously-skip-permissions flag (or OPENTABS_SKIP_PERMISSIONS=1
 * env var) bypasses all browser tool permission prompts. This is a
 * dangerous option that disables human-in-the-loop safety for sensitive
 * browser operations. It exists for CI/testing environments where no human
 * is available to approve tool calls.
 *
 * The old names (--dangerously-skip-confirmation / OPENTABS_SKIP_CONFIRMATION)
 * are accepted for backward compatibility.
 *
 * The config.json `skipPermissions` field is checked separately at reload
 * time and combined with this flag in state.skipPermissions.
 */

const cliSkipPermissions =
  process.argv.includes('--dangerously-skip-permissions') ||
  process.argv.includes('--dangerously-skip-confirmation') ||
  process.env.OPENTABS_SKIP_PERMISSIONS === '1' ||
  process.env.OPENTABS_SKIP_CONFIRMATION === '1';

/** Whether the CLI flag or env var requests permission bypass */
export const isCliSkipPermissions = (): boolean => cliSkipPermissions;
