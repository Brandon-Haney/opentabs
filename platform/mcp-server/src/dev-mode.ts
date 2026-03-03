/**
 * Dev mode detection — determined once at startup and stored for the process lifetime.
 *
 * Dev mode is enabled by passing --dev on the command line or setting OPENTABS_DEV=1
 * in the environment. Production mode is the default when neither is present.
 *
 * Dev mode enables: file watchers for local plugins, config.json watching, mtime
 * polling fallback, and the POST /reload HTTP endpoint.
 *
 * Production mode: static plugin discovery at startup, restart to reload.
 */

const devMode =
  process.argv.includes('--dev') || process.env.OPENTABS_DEV === '1' || process.env.OPENTABS_DEV === 'true';

/** Whether the server is running in dev mode (file watchers, hot reload, config watching) */
export const isDev = (): boolean => devMode;
