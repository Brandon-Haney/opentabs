/**
 * Workbook connections to a Power BI semantic model.
 *
 * Both shapes here were taken verbatim from what Excel's own
 * "Data > Get Data from Power BI" pane sends, rather than reconstructed. The two
 * differ in one argument pair that is easy to get wrong: a connection backing a
 * *table* carries a DAX query and a numeric command type, while one backing a
 * *PivotTable* carries the literal strings "Model" and "Cube".
 */

/**
 * Client id in the connection string's `Identity Provider` clause.
 *
 * This is the Power BI Excel integration's own public application id, not a
 * secret and not the user's — the connection authenticates with the session, and
 * this only names which application's consent the token is issued under.
 */
const POWER_BI_EXCEL_CLIENT_ID = '929d0ec0-7a41-4b1e-bc7c-b754a28bddcc';

/**
 * Build the OLE DB connection string for a semantic model.
 *
 * `Initial Catalog` takes the **plain dataset GUID**. Excel rewrites it to the
 * `sobe_wowvirtualserver-<guid>` form when it saves the workbook, so the value
 * `inspect_data_model` reads back out of `xl/connections.xml` is not the value
 * to send here.
 */
export const powerBiConnectionString = (datasetId: string): string =>
  'OLEDB;Provider=MSOLAP;Integrated Security=ClaimsToken;' +
  `Identity Provider=https://login.microsoftonline.com/common, https://analysis.windows.net/powerbi/api, ${POWER_BI_EXCEL_CLIENT_ID};` +
  'Persist Security Info=True;Data Source=pbiazure://api.powerbi.com;' +
  `Initial Catalog=${datasetId};` +
  'MDX Compatibility= 1; MDX Missing Member Mode= Error; Safety Options= 2; Update Isolation Level= 2;' +
  'Locale Identifier=1033;';

/** `DataConnections.Add` command and type for a connection a PivotTable reads. */
export const CUBE_COMMAND = ['Model', 'Cube'] as const;

/** `DataConnections.Add` command type for a connection whose command is a DAX query. */
export const DAX_COMMAND_TYPE = 4;

/**
 * Qualify a destination cell with its sheet, quoting the name when it contains
 * anything that would break the reference. An unquoted sheet name with a space
 * is rejected as an invalid argument.
 */
export const qualifyDestination = (worksheet: string, cell: string): string =>
  /^[A-Za-z0-9_]+$/.test(worksheet) ? `${worksheet}!${cell}` : `'${worksheet.replace(/'/g, "''")}'!${cell}`;
