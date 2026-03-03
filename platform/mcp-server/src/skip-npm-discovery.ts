/**
 * NPM auto-discovery bypass — determined once at startup.
 *
 * Setting OPENTABS_SKIP_NPM_DISCOVERY=1 disables scanning of global
 * node_modules for opentabs plugins. Only local plugins specified in
 * config.localPlugins are discovered when this flag is set.
 *
 * This is used by E2E tests to prevent globally-installed npm plugins
 * on the developer's machine from polluting test isolation.
 */

const skipNpmDiscovery = process.env.OPENTABS_SKIP_NPM_DISCOVERY === '1';

export const isSkipNpmDiscovery = (): boolean => skipNpmDiscovery;
