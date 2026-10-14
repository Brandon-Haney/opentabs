import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { ReportParametersRejectedError } from '../bi-publisher.js';
import { printRgn } from '../rgn.js';
import { printedRgnSchema } from './rgn-schemas.js';

export const getRgn = defineTool({
  name: 'get_rgn',
  displayName: 'Get RGN',
  description:
    'Read one RGN (return goods notice) line by line, from the R-442 Print RGN report: every part with its Fusion ' +
    'item number, the quantity and amount requested from the DC, and the quantity and amount the DC credited. The ' +
    'Payables debit memo of the same number shows descriptions only, and identical descriptions span different ' +
    'parts, so this report is the reliable source for which parts an RGN carries.',
  summary: 'Read an RGN’s parts, requested and credited',
  icon: 'file-text',
  group: 'Returns',
  input: z.object({
    rgn_number: z.string().min(1).describe('RGN number (e.g., "ATL081-100310")'),
  }),
  output: printedRgnSchema,
  handle: async (params, context) => {
    const notFound = () => ToolError.notFound(`Oracle Fusion has no RGN ${params.rgn_number} visible to this user.`);
    const rgn = await printRgn(params.rgn_number.trim(), message => context?.reportProgress({ message })).catch(
      (error: unknown) => {
        throw error instanceof ReportParametersRejectedError ? notFound() : error;
      },
    );
    if (!rgn.found) throw notFound();
    const { found: _found, ...printed } = rgn;
    return printed;
  },
});
