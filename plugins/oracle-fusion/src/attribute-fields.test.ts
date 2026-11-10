import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import type { AdfWindow, RichEvent } from './adf-window.js';
import {
  addAttributeField,
  confirmAttributesEvent,
  isAttributeChosen,
  moveAttributeEvent,
  openAttributeDialogEvent,
  readAttributeDialog,
} from './attribute-fields.js';
import type { QueryPanel } from './search-page.js';

const R = 'r:MAt2:0:pt1:ItemC1:0:sp1:region2:0:';
const PANEL_ID = `${R}efqrp`;
const TREE = `${R}shuttleRnIdAddFields:0:ATR4:_ATTp:ATRr4`;
const SHUTTLE = `${R}shuttleRnIdAddFields`;
const CHOSEN = `${SHUTTLE}:0:AT1:_ATp:ATt1`;

const respond = (html: string, script = ''): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment>` +
      `<script><![CDATA[${script}]]></script></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

const panel: QueryPanel = {
  id: PANEL_ID,
  collapsed: false,
  values: { [`${PANEL_ID}:value00`]: '' },
  fieldsByLabel: new Map([['Item', `${PANEL_ID}:value00`]]),
  datePatterns: new Map(),
  checkboxValues: new Map(),
  choices: new Map(),
  addableFields: new Map(),
};

/** A row of the attribute tree; its node cell sits in the row's inner table. */
const treeRow = (key: string, ancestors: string, label: string): string =>
  `<tr _afrRK="${key}"${ancestors ? ` _afrAP="${ancestors}"` : ''}><td _afrRH="true">&nbsp;</td><td><div>` +
  `<table _afrIT="1"><tr><td _afrNdCol="1"><div><span _afrDisImg="2"><a title="Expand"></a></span>` +
  `<span><table><tbody><tr><td><span title="${label}">${label}</span></td></tr></tbody></table></span>` +
  '</div></td></tr></table></div></td></tr>';

const opened = respond(
  `<div id="${R}addFP::content"><div id="${R}addFieldsDialog"><div id="${TREE}"><div id="${TREE}::db"><table>` +
    treeRow('0', '', 'Item') +
    treeRow('1', '0', 'Basic') +
    treeRow('7', '', 'Item Relationships') +
    '</table></div></div>' +
    `<input name="${TREE.replace(':ATRr4', ':fit16')}" value="">` +
    `<div id="${SHUTTLE}:0:cb1" title="Move"><a role="button"><img id="${SHUTTLE}:0:cb1::icon" title="Move"></a></div>` +
    `<button id="${R}okButtonAddFields">O<span>K</span></button><button id="${R}CancelButtonAddFields">Cancel</button>` +
    '</div></div>',
  `AdfPage.PAGE.addComponents(new AdfRichRegion('${SHUTTLE}'),new AdfRichDialog('${R}addFieldsDialog',{}),` +
    `new AdfRichTreeTable('${TREE}',{'rowSelection':'multiple','disclosedRowKeys':{'0':true},'x':1}));`,
);

const expanded = (rows: string) => respond(`<table _rowCount="9">${rows}</table>`);

const chosen = (attributes: [string, string, string][]) =>
  respond(
    `<table><tr><th id="${CHOSEN}:c1">Entity</th><th id="${CHOSEN}:c2">Attribute Group</th>` +
      `<th id="${CHOSEN}:c3">Attribute</th></tr></table><div id="${CHOSEN}::db"><table>` +
      attributes
        .map(
          (cells, index) =>
            `<tr _afrRK="${index}"><td _afrRH="true">&nbsp;</td><td><table _afrIT="1"><tr>` +
            `${cells.map(cell => `<td>${cell}</td>`).join('')}</tr></table></td></tr>`,
        )
        .join('') +
      '</table></div>',
    `new AdfRichTable('${CHOSEN}',{})`,
  );

/** A window that answers each event with the next response, recording the events. */
const scriptedWindow = (responses: RichResponse[]) => {
  const events: RichEvent[] = [];
  const adfWindow: AdfWindow = {
    homeHtml: '',
    submit: async event => {
      events.push(event);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected event on ${event.source}`);
      return next;
    },
    download: async () => {
      throw new Error('no downloads');
    },
  };
  return { adfWindow, events };
};

describe('the Add Fields dialog of attributes', () => {
  test('opens from the panel’s Add Fields button, processed under the panel', () => {
    expect(openAttributeDialogEvent(panel)).toMatchObject({
      source: `${PANEL_ID}:addFldsCmd`,
      process: PANEL_ID,
      fields: panel.values,
    });
  });

  test('reads the tree, its expanded rows, the Move and OK buttons and the dialog’s fields', () => {
    const dialog = readAttributeDialog(opened);
    expect(dialog).toMatchObject({
      dialog: { dialogId: `${R}addFieldsDialog`, popupId: `${R}addFP` },
      treeId: TREE,
      disclosedKeys: ['0'],
      moveButton: `${SHUTTLE}:0:cb1`,
      shuttle: SHUTTLE,
      okButton: `${R}okButtonAddFields`,
      fields: { [TREE.replace(':ATRr4', ':fit16')]: '' },
    });
    expect(dialog.rows.map(row => row.label)).toEqual(['Item', 'Basic', 'Item Relationships']);
    expect(moveAttributeEvent(dialog, {})).toMatchObject({ source: `${SHUTTLE}:0:cb1`, process: SHUTTLE });
    expect(confirmAttributesEvent(dialog, {})).toMatchObject({ source: `${R}okButtonAddFields`, process: `${R}addFP` });
  });

  test('refuses a response that opened no such dialog', () => {
    expect(() => readAttributeDialog(respond('<div></div>'))).toThrow(/opened no dialog/);
  });

  test('tells whether the chosen attributes hold an attribute', () => {
    const path = ['Item Relationships', 'GTIN', 'GTIN'];
    expect(isAttributeChosen(chosen([['Item Relationships', 'GTIN', 'GTIN']]), SHUTTLE, path)).toBe(true);
    expect(isAttributeChosen(chosen([['Item Relationships', 'GTIN', 'GTIN UOM']]), SHUTTLE, path)).toBe(false);
    expect(isAttributeChosen(respond('<div></div>'), SHUTTLE, path)).toBe(false);
  });

  test('expands the tree level by level, selects the attribute, moves it and answers OK', async () => {
    const answered = respond('<div>panel</div>');
    const { adfWindow, events } = scriptedWindow([
      opened,
      expanded(treeRow('8', '7', 'Catalog') + treeRow('12', '7', 'GTIN')),
      expanded(treeRow('18', '7_12', 'GDSN Enabled') + treeRow('19', '7_12', 'GTIN')),
      respond('<div></div>'),
      chosen([['Item Relationships', 'GTIN', 'GTIN']]),
      answered,
    ]);

    await expect(addAttributeField(adfWindow, panel, ['Item Relationships', 'GTIN', 'GTIN'])).resolves.toBe(answered);
    expect(events.map(event => event.source)).toEqual([
      `${PANEL_ID}:addFldsCmd`,
      TREE,
      TREE,
      TREE,
      `${SHUTTLE}:0:cb1`,
      `${R}okButtonAddFields`,
    ]);
    expect(events[1]?.deltas).toContain('disclosedRowKeys=0$afr$7}');
    expect(events[2]?.deltas).toContain('disclosedRowKeys=0$afr$7$afr$12}');
    expect(events[3]?.deltas).toBe(`{${TREE}={selectedRowKeys=19}}`);
  });

  test('does not expand rows the tree shows expanded already', async () => {
    const { adfWindow, events } = scriptedWindow([
      respond(
        opened.document.body.innerHTML.replace(
          '</table></div></div>',
          `${treeRow('12', '7', 'GTIN')}${treeRow('19', '7_12', 'GTIN')}</table></div></div>`,
        ),
        `new AdfRichRegion('${SHUTTLE}'),new AdfRichDialog('${R}addFieldsDialog',{}),` +
          `new AdfRichTreeTable('${TREE}',{'disclosedRowKeys':{'0':true,'7':true,'12':true}})`,
      ),
      respond('<div></div>'),
      chosen([['Item Relationships', 'GTIN', 'GTIN']]),
      respond('<div>panel</div>'),
    ]);
    await addAttributeField(adfWindow, panel, ['Item Relationships', 'GTIN', 'GTIN']);
    expect(events.map(event => event.source)).toEqual([
      `${PANEL_ID}:addFldsCmd`,
      TREE,
      `${SHUTTLE}:0:cb1`,
      `${R}okButtonAddFields`,
    ]);
  });

  test('fetches the rows above when the tree opens scrolled down, then walks the path from the top', async () => {
    const scrolled = respond(
      `<div id="${R}addFP::content"><div id="${R}addFieldsDialog"><div id="${TREE}"><div id="${TREE}::db">` +
        `<table _rowCount="22" _startRow="10">${treeRow('4', '1', 'Cross Reference')}${treeRow('2', '1', 'GTIN')}` +
        `${treeRow('3', '1_2', 'GTIN')}</table></div></div>` +
        `<div id="${SHUTTLE}:0:cb1" title="Move"></div><button id="${R}okButtonAddFields">OK</button></div></div>`,
      `new AdfRichRegion('${SHUTTLE}'),new AdfRichDialog('${R}addFieldsDialog',{}),` +
        `new AdfRichTreeTable('${TREE}',{'disclosedRowKeys':{'0':true,'1':true,'2':true}})`,
    );
    const earlier = respond(
      `<div id="${TREE}::dataW" style="display:none"><table _rowCount="22" _startRow="0">` +
        `${treeRow('0', '', 'Item')}${treeRow('1', '', 'Item Relationships')}</table></div>`,
    );
    const { adfWindow, events } = scriptedWindow([
      scrolled,
      earlier,
      respond('<div></div>'),
      chosen([['Item Relationships', 'GTIN', 'GTIN']]),
      respond('<div>panel</div>'),
    ]);
    await addAttributeField(adfWindow, panel, ['Item Relationships', 'GTIN', 'GTIN']);
    expect(events[1]?.payload).toContain('<k v="subtype"><n>1</n></k><k v="index"><n>10</n></k>');
    expect(events[1]?.payload).toContain('<k v="clientKey"><s>4</s></k>');
    expect(events[1]?.deltas).toBe(`{${TREE}={viewportSize=10000,_afrFstVbl=10,scrollTopRowKey|p=4}}`);
    expect(events[2]?.deltas).toBe(`{${TREE}={selectedRowKeys=3}}`);
  });

  test('names the level the tree does not list', async () => {
    const { adfWindow } = scriptedWindow([opened, expanded(treeRow('8', '7', 'Catalog'))]);
    await expect(addAttributeField(adfWindow, panel, ['Item Relationships', 'GTIN', 'GTIN'])).rejects.toThrow(
      'The Oracle Fusion Add Fields dialog lists no "GTIN" under "Item Relationships".',
    );
  });

  test('fails when Move did not take the attribute', async () => {
    const { adfWindow } = scriptedWindow([
      opened,
      expanded(treeRow('12', '7', 'GTIN')),
      expanded(treeRow('19', '7_12', 'GTIN')),
      respond('<div></div>'),
      chosen([]),
    ]);
    await expect(addAttributeField(adfWindow, panel, ['Item Relationships', 'GTIN', 'GTIN'])).rejects.toThrow(
      /did not take the Item Relationships → GTIN → GTIN attribute/,
    );
  });
});
