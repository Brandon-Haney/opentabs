/**
 * Background script log collector instance.
 *
 * Extracted to a separate module so both background.ts and browser-commands.ts
 * can access the log collector without circular imports (background.ts imports
 * message-router.ts which imports browser-commands.ts).
 */

import { installLogCollector } from './log-collector.js';

const bgLogCollector = installLogCollector('background');

export { bgLogCollector };
