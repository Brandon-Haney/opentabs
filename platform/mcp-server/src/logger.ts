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
 * Each method prepends the [opentabs] tag automatically. The interface is
 * intentionally minimal — no dependencies, no formatting libraries, no
 * structured JSON output. Just level-gated console methods with a consistent
 * prefix.
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

const parseLevel = (raw: string | undefined): LogLevel => {
  if (raw && raw in LEVELS) return raw as LogLevel;
  return 'info';
};

const currentLevel = LEVELS[parseLevel(Bun.env.OPENTABS_LOG_LEVEL)];

const log = {
  /** Verbose diagnostic output — suppressed by default */
  debug: (...args: unknown[]): void => {
    if (currentLevel <= LEVELS.debug) {
      console.debug(TAG, new Date().toISOString(), ...args);
    }
  },

  /** Normal operational messages */
  info: (...args: unknown[]): void => {
    if (currentLevel <= LEVELS.info) {
      console.log(TAG, new Date().toISOString(), ...args);
    }
  },

  /** Potential problems that don't prevent operation */
  warn: (...args: unknown[]): void => {
    if (currentLevel <= LEVELS.warn) {
      console.warn(TAG, new Date().toISOString(), ...args);
    }
  },

  /** Failures that affect functionality */
  error: (...args: unknown[]): void => {
    if (currentLevel <= LEVELS.error) {
      console.error(TAG, new Date().toISOString(), ...args);
    }
  },
};

export { log };
