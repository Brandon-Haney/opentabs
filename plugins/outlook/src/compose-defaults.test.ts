import { ToolError } from '@opentabs-dev/plugin-sdk';
import { describe, expect, test, vi } from 'vitest';

vi.mock('./outlook-api.js', () => ({ owsRequest: vi.fn() }));

const { assertPlainText } = await import('./compose-defaults.js');

describe('assertPlainText', () => {
  test('accepts ordinary text, including angle brackets that are not tags', () => {
    expect(() => assertPlainText('Thanks,\nBrandon')).not.toThrow();
    expect(() => assertPlainText('If qty < 3 and total > 10, hold it. Reply to <jane@contoso.com>.')).not.toThrow();
    expect(() => assertPlainText('Use the <TBD> column and a->b mapping.')).not.toThrow();
  });

  test('refuses text written in HTML, naming the tag', () => {
    const body = '<div style="font-size:12pt">Hi</div><table><tr><td>1</td></tr></table>';
    expect(() => assertPlainText(body)).toThrow(ToolError);
    expect(() => assertPlainText(body)).toThrow(/<div style="font-size:12pt">.*body_type to "html"/);
  });

  test('refuses closing and self-closing tags in any case', () => {
    expect(() => assertPlainText('line one<BR/>line two')).toThrow(ToolError);
    expect(() => assertPlainText('done</p>')).toThrow(ToolError);
  });
});
