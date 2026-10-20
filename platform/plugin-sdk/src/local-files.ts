import type { LocalFile } from '@opentabs-dev/shared';
import { ToolError } from './errors.js';
import type { ToolHandlerContext } from './index.js';

/**
 * Read the local file the MCP server delivered for `path`, a value the caller
 * passed in an input field declared with `format: LOCAL_FILE_PATH_FORMAT`.
 *
 * Throws a validation `ToolError` when the platform running the tool predates
 * local-file delivery or no file arrived for that path.
 */
export const readLocalFile = (context: ToolHandlerContext | undefined, path: string): LocalFile => {
  if (!context?.localFile) {
    throw ToolError.validation(
      'This OpenTabs version cannot read local files. Update OpenTabs and reload the extension, then try again.',
    );
  }
  try {
    return context.localFile(path);
  } catch {
    throw ToolError.validation(`No local file was read for "${path}".`);
  }
};

/**
 * Hand `contentBase64` to the MCP server to write to `path`, a value the caller
 * passed in an input field declared with `format: SAVE_FILE_PATH_FORMAT`. The
 * server writes the file after the handler returns, so the handler's output
 * should report the path, never the bytes.
 *
 * Throws a validation `ToolError` when the platform running the tool predates
 * saving files.
 */
export const saveLocalFile = (context: ToolHandlerContext | undefined, path: string, contentBase64: string): void => {
  if (!context?.saveFile) {
    throw ToolError.validation(
      'This OpenTabs version cannot save files. Update OpenTabs and reload the extension, then try again.',
    );
  }
  context.saveFile(path, contentBase64);
};
