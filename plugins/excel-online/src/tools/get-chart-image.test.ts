import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { describe, expect, test, vi } from 'vitest';
import { buildChartImagePath, decodedBase64Size, getChartImage } from './get-chart-image.js';

/** A handler context whose workbook session answers every call with `body`. */
const sessionContext = (body: unknown) => {
  const saveFile = vi.fn<(path: string, contentBase64: string) => void>();
  const context: ToolHandlerContext = {
    reportProgress: () => undefined,
    bridge: async () => ({ response: JSON.stringify(body) }),
    saveFile,
  };
  return { context, saveFile };
};

describe('get_chart_image', () => {
  test('uses the bare image segment when no sizing is requested', () => {
    expect(buildChartImagePath('Sheet1', 'Chart 1', {})).toBe("/worksheets('Sheet1')/charts('Chart%201')/image");
  });

  test('passes only the sizing arguments that were given', () => {
    expect(buildChartImagePath('Sheet1', 'Chart 1', { width: 800, fittingMode: 'Fill' })).toBe(
      "/worksheets('Sheet1')/charts('Chart%201')/image(width=800,fittingMode='Fill')",
    );
  });

  test('counts the decoded bytes of padded and unpadded base64', () => {
    expect(decodedBase64Size(btoa('abc'))).toBe(3);
    expect(decodedBase64Size(btoa('abcd'))).toBe(4);
    expect(decodedBase64Size(btoa('abcde'))).toBe(5);
  });

  test('writes the PNG to save_to and reports its path and size, not its bytes', async () => {
    const png = btoa('\x89PNG\r\n\x1a\n');
    const { context, saveFile } = sessionContext({ value: png });

    const result = await getChartImage.handle(
      { worksheet: 'Sheet1', chart: 'Chart 1', save_to: '/tmp/chart.png' },
      context,
    );

    expect(saveFile).toHaveBeenCalledWith('/tmp/chart.png', png);
    expect(result).toEqual({ saved_to: '/tmp/chart.png', mime_type: 'image/png', size: 8 });
  });

  test('refuses a chart that rendered no image', async () => {
    const { context, saveFile } = sessionContext({});

    await expect(
      getChartImage.handle({ worksheet: 'Sheet1', chart: 'Chart 1', save_to: '/tmp/chart.png' }, context),
    ).rejects.toThrow('no image');
    expect(saveFile).not.toHaveBeenCalled();
  });
});
