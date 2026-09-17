import { describe, expect, test } from 'vitest';
import { buildFreezePanesContext, buildFreezePanesOptions } from './freeze-panes.js';

describe('freeze_panes', () => {
  test('anchors the scrolling pane just past the frozen rows and columns, as the editor does from A1', () => {
    expect(buildFreezePanesOptions('Sheet1', 2, 1)).toEqual({
      freezeSettings: {
        SheetName: 'Sheet1',
        Freeze: true,
        FrozenRows: 2,
        FrozenColumns: 1,
        FirstRow: 2,
        FirstColumn: 1,
      },
    });
  });

  test('unfreezes when both counts are zero', () => {
    expect(buildFreezePanesOptions('Sheet1', 0, 0).freezeSettings).toMatchObject({ Freeze: false, FirstRow: 0 });
  });

  test('names the target sheet as active and marks the call as a blocking UI operation', () => {
    const context = buildFreezePanesContext('Sheet1', 1789662713480);
    expect(context).toMatchObject({
      SheetName: 'Sheet1',
      ViewportStateChange: {
        ActiveSheetName: 'Sheet1',
        SheetViewportStateChanges: [{ SheetName: 'Sheet1', TopLeft: 'A1' }],
      },
      BlockingUIOperation: true,
      BlockingUIOperationTimestamp: '1789662713480',
    });
  });
});
