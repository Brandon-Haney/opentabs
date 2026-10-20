/**
 * Local files a tool call hands to a plugin, and files a plugin hands back.
 *
 * Plugin adapters run in the page and cannot touch the user's disk. A tool input
 * field whose JSON Schema carries `format: LOCAL_FILE_PATH_FORMAT` takes an
 * absolute path instead: when the tool is called, the MCP server reads each such
 * file and sends its bytes to the extension with that one dispatch, and the
 * handler reads them through `ToolHandlerContext.localFile(path)`.
 *
 * The reverse runs through a field carrying `format: SAVE_FILE_PATH_FORMAT`: the
 * handler passes file bytes to `ToolHandlerContext.saveFile(path, …)`, they ride
 * back beside the tool's output, and the MCP server writes them to that path.
 * The bytes never enter the output the MCP client sees.
 *
 * Either way the page never names a path on its own — the server reads and
 * writes only the paths the caller passed in fields the plugin's schema
 * declares — so no page script can reach the disk.
 */

/** JSON Schema `format` marking a string input as a path the server reads from disk. */
export const LOCAL_FILE_PATH_FORMAT = 'local-file-path';

/** JSON Schema `format` marking a string input as a path the server writes a tool's file to. */
export const SAVE_FILE_PATH_FORMAT = 'save-file-path';

/**
 * Largest total size, in bytes, of the local files one tool call may carry in
 * either direction — read for the call, or saved from it. The bytes cross the
 * WebSocket and the extension's script-injection boundary as base64, so the
 * ceiling keeps each dispatch well inside both transports.
 */
export const MAX_LOCAL_FILE_BYTES = 25 * 1024 * 1024;

/** A local file as delivered to a tool handler. */
export interface LocalFile {
  /** File name with extension, without its directory */
  name: string;
  /** Size in bytes */
  size: number;
  /** MIME type inferred from the file extension (`application/octet-stream` when unknown) */
  contentType: string;
  /** File content, base64-encoded */
  contentBase64: string;
}
