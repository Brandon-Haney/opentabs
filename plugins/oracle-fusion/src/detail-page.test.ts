import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import {
  clickEvent,
  confirmCloseTabEvent,
  expandSectionEvent,
  fetchPopupEvent,
  findCloseTabWarning,
  findCollapsedSection,
  findDoneButton,
  findPopupButton,
  findRowLink,
  parseDetailFields,
} from './detail-page.js';

const respond = (html: string): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<?Adf-Rich-Response-Type ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

const field = (label: string, value: string): string =>
  `<tr><td valign="top"><label>${label}</label></td><td valign="top"><span>${value}</span></td></tr>`;

describe('parseDetailFields', () => {
  test('reads each label with the value beside it', () => {
    const page = respond(
      `<table><tbody>${field('Item', 'A-1')}${field('Locator', '')}${field('Error Explanation', 'Bad  locator\n segments.')}</tbody></table>`,
    );
    expect(parseDetailFields(page)).toEqual({ Item: 'A-1', Locator: '', 'Error Explanation': 'Bad locator segments.' });
  });

  test('skips dropdowns, keeps the first of repeated labels, and ignores rows that are not label pairs', () => {
    const page = respond(
      '<table><tbody>' +
        '<tr><td><label>Transaction ID</label></td><td><select><option>1001</option><option>1002</option></select></td></tr>' +
        field('Transaction ID', '1001') +
        field('Transaction ID', '9999') +
        '<tr><td><label>Wide</label></td><td>a</td><td>b</td></tr>' +
        '<tr><td>No label</td><td>x</td></tr>' +
        '</tbody></table>',
    );
    expect(parseDetailFields(page)).toEqual({ 'Transaction ID': '1001' });
  });
});

describe('navigation', () => {
  const results = respond(
    '<table><tr><td><a id="r:app:table1:3:commandLink1" href="#">1001</a></td></tr>' +
      '<tr><td><a id="r:app:table1:4:commandLink1" href="#">1002</a></td></tr></table>' +
      '<a id="r:app:help" href="#">1001</a>',
  );

  test('finds a row link by its text and ignores links outside rows', () => {
    expect(findRowLink(results, '1002')).toBe('r:app:table1:4:commandLink1');
    expect(findRowLink(results, '1001')).toBe('r:app:table1:3:commandLink1');
    expect(findRowLink(results, '9999')).toBeNull();
  });

  test('finds the Done button of a detail page', () => {
    expect(findDoneButton(respond('<div id="r:app:ap:SPb"><a>Done</a></div>'))).toBe('r:app:ap:SPb');
    expect(findDoneButton(results)).toBeNull();
  });

  test('clicks with an action event', () => {
    expect(clickEvent('r:app:ap:SPb')).toEqual({
      source: 'r:app:ap:SPb',
      payload: '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>',
      fields: undefined,
    });
  });
});

describe('collapsed sections', () => {
  const page = respond(
    '<div id="r:ap1:sdh1"><a id="r:ap1:sdh1::_afrDscl" aria-expanded="false" aria-label="Expand Additional Information"></a></div>' +
      '<div id="r:ap1:sdh2"><a id="r:ap1:sdh2::_afrDscl" aria-expanded="true" aria-label="Collapse Line Details"></a></div>',
  );

  test('finds a collapsed section by its title', () => {
    expect(findCollapsedSection(page, 'Additional Information')).toBe('r:ap1:sdh1');
    expect(findCollapsedSection(page, 'Line Details')).toBeNull();
  });

  test('expands a section by disclosing it', () => {
    expect(expandSectionEvent('r:ap1:sdh1')).toEqual({
      source: 'r:ap1:sdh1',
      payload:
        '<m xmlns="http://oracle.com/richClient/comm"><k v="expand"><b>1</b></k><k v="type"><s>disclosure</s></k></m>',
      fields: undefined,
      render: 'r:ap1:sdh1',
      deltas: '{r:ap1:sdh1={disclosed=true}}',
    });
  });
});

describe('close-tab warning', () => {
  const left = parseRichResponse(
    '<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[<div></div>]]></fragment>' +
      "<script><![CDATA[AdfPage.PAGE.findComponent('r:0:MApopup').show();]]></script>" +
      "<script>AdfPage.PAGE.findComponent('r:0:MAwarn').show();</script></content>",
  );
  const shown = respond(
    '<div id="r:0:MAwarn::content"><div>You have not saved your changes.</div>' +
      '<button id="r:0:MAyes">Yes</button><button id="r:0:MAno">No</button></div>',
  );

  test('finds the close-tab warning a response shows, and no other popup', () => {
    if (!left) throw new Error('fixture is not a rich response');
    expect(findCloseTabWarning(left)).toBe('r:0:MAwarn');
    expect(findCloseTabWarning(shown)).toBeNull();
  });

  test('confirms it with its Yes button under the shell region', () => {
    expect(findPopupButton(shown, 'Yes')).toBe('r:0:MAyes');
    expect(fetchPopupEvent('r:0:MAwarn').payload).toContain('<s>fetch</s>');
    expect(confirmCloseTabEvent('pt1:r:0:MAwarn', 'pt1:r:0:MAyes')).toEqual({
      source: 'pt1:r:0:MAyes',
      payload: '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>',
      process: 'pt1:r:0:MAwarn',
      render: 'pt1:r',
      deltas: '{pt1:r:0:MAwarn={_shown=pt1:r:0:MAwarn}}',
    });
  });
});
