import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge } from '../bridge.js';

/**
 * Refresh every data connection in the workbook at once.
 *
 * The method is `RefreshAllNew`, which is what the Data > Refresh All button
 * sends. `RefreshAll` is not a method on this service and answers 401, which
 * reads like an authorisation problem rather than a wrong name.
 *
 * Unlike the single-connection `Refresh`, this needs no per-session AAD token:
 * the whole request body is two booleans. That makes it both simpler and more
 * reliable than refreshing connections one at a time, since a token that the
 * embedded app has not minted yet is the usual reason a single refresh fails.
 */
export const refreshAllConnections = defineTool({
  name: 'refresh_all_connections',
  displayName: 'Refresh All Connections',
  description:
    "Refresh every data connection in the workbook, the equivalent of Excel's Data > Refresh All. " +
    'Prefer this over calling refresh_pivot per connection: it is one call regardless of how many connections exist, and it needs no per-session token, which is the usual reason a single-connection refresh fails. ' +
    'Use it after the underlying model has been updated, or when PivotTable values look stale. It re-queries the external sources; it does not change any layout or filter. ' +
    'Returns as soon as the refresh is accepted rather than when it completes — a large model can take several seconds more, so re-read values rather than assuming they are current the instant this returns.',
  summary: 'Refresh every data connection in the workbook',
  icon: 'refresh-cw',
  group: 'Data Model',
  input: z.object({}),
  output: bridgeOutputSchema,
  handle: async () => ewaBridge('RefreshAllNew', { periodic: false, refreshOnOpen: false }),
});
