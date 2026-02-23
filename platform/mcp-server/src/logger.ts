/**
 * Lightweight structured logger with level filtering.
 *
 * All server log output flows through this module so that verbosity can be
 * controlled via the OPENTABS_LOG_LEVEL environment variable:
 *
 *   OPENTABS_LOG_LEVEL=debug   — all messages (debug + info + warn + error)
 *   OPENTABS_LOG_LEVEL=info    — info + warn + error (default)
 *   OPENTABS_LOG_LEVEL=warn    — warn + error only
 *   OPENTABS_LOG_LEVEL=error   — errors only
 *   OPENTABS_LOG_LEVEL=silent  — suppress all output
 *
 * Each method prepends the [opentabs] tag automatically and detects Error
 * instances passed as the last argument: at info/warn/error level, the Error
 * is replaced with its message string; at debug level, the stack trace is
 * appended. Callers should pass raw Error objects (not err.message) so the
 * logger can format them appropriately per level.
 *
 * Hot reload safe: reads the env var once at module evaluation time. Under
 * bun --hot, the module is re-evaluated on each reload, picking up any
 * runtime changes to the environment variable.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const TAG = '[opentabs]';

/**
 * Format log arguments, detecting Error instances as the last argument.
 * At debug level (includeStack = true), appends the stack trace indented
 * on the next line. At other levels, replaces the Error object with its
 * message string so stack traces don't clutter normal output.
 */
const formatArgs = (args: unknown[], includeStack: boolean): unknown[] => {
  const last = args[args.length - 1];
  if (last instanceof Error) {
    const rest = args.slice(0, -1);
    if (includeStack && last.stack) {
      return [...rest, last.message + '\n  ' + last.stack];
    }
    return [...rest, last.message];
  }
  return args;
};

const parseLevel = (raw: string | undefined): LogLevel => {
  if (!raw) return 'info';
  const normalized = raw.toLowerCase();
  if (normalized in LEVELS) return normalized as LogLevel;
  return 'info';
};

const currentLevel = LEVELS[parseLevel(Bun.env.OPENTABS_LOG_LEVEL)];

const log = {
  /** Verbose diagnostic output — suppressed by default */
  debug: (...args: unknown[]): void => {
    if (currentLevel <= LEVELS.debug) {
      console.debug(TAG, new Date().toISOString(), ...formatArgs(args, true));
    }
  },

  /** Normal operational messages */
  info: (...args: unknown[]): void => {
    if (currentLevel <= LEVELS.info) {
      console.log(TAG, new Date().toISOString(), ...formatArgs(args, false));
    }
  },

  /** Potential problems that don't prevent operation */
  warn: (...args: unknown[]): void => {
    if (currentLevel <= LEVELS.warn) {
      console.warn(TAG, new Date().toISOString(), ...formatArgs(args, false));
    }
  },

  /** Failures that affect functionality */
  error: (...args: unknown[]): void => {
    if (currentLevel <= LEVELS.error) {
      console.error(TAG, new Date().toISOString(), ...formatArgs(args, false));
    }
  },
};

export { log };
