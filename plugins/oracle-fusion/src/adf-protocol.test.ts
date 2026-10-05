import { describe, expect, test } from 'vitest';
import {
  parseLoopback,
  parsePageState,
  parseRichResponse,
  richEvent,
  richEventBatch,
  windowQuery,
} from './adf-protocol.js';

const envelope = (body: string): string =>
  `<?xml version="1.0" ?>\n<?Adf-Rich-Response-Type ?>\n<content action="/fscmUI/faces/FuseWelcome?_adf.ctrl-state=abc_7&amp;x=1">${body}</content>`;

describe('richEvent', () => {
  test('writes the type last, after the other keys in order', () => {
    expect(richEvent('disclosure', { expand: true })).toBe(
      '<m xmlns="http://oracle.com/richClient/comm"><k v="expand"><b>1</b></k><k v="type"><s>disclosure</s></k></m>',
    );
  });

  test('encodes a null value as a key without a body', () => {
    expect(richEvent('query', { clearAll: null })).toBe(
      '<m xmlns="http://oracle.com/richClient/comm"><k v="clearAll"/><k v="type"><s>query</s></k></m>',
    );
  });

  test('encodes numbers and batches events fired at one component', () => {
    expect(richEventBatch([['rowDisclosure'], ['fetch', { id: 2 }]])).toBe(
      '<a xmlns="http://oracle.com/richClient/comm" n="2"><m><k v="type"><s>rowDisclosure</s></k></m>' +
        '<m><k v="id"><n>2</n></k><k v="type"><s>fetch</s></k></m></a>',
    );
  });

  test('escapes markup in string values', () => {
    expect(richEvent('action', { label: 'a<b>&"c"' })).toContain('<s>a&lt;b&gt;&amp;&quot;c&quot;</s>');
  });
});

describe('parseLoopback', () => {
  const loopback =
    `<script>var extraParams = {'_adf.ctrl-state':'abc_3'};\n` +
    `query = _addParam(query, "_afrLoop", "1234567890");</script>`;

  test('reads the loopback id and control state', () => {
    expect(parseLoopback(loopback)).toEqual({ loopbackId: '1234567890', controlState: 'abc_3' });
  });

  test('returns null for a page that is not the loopback script', () => {
    expect(parseLoopback('<html><body><form action="/login"></form></body></html>')).toBeNull();
  });

  test('asks the server for a new window', () => {
    const query = windowQuery({ loopbackId: '1234567890', controlState: 'abc_3' });
    expect(query).toMatchObject({ _afrLoop: '1234567890', _afrWindowId: 'null', '_adf.ctrl-state': 'abc_3' });
  });
});

describe('parsePageState', () => {
  test('reads the form action and view state, decoding the attribute', () => {
    const html =
      '<form id="f1" name="f1" method="POST" action="/fscmUI/faces/FuseWelcome?_adf.ctrl-state=abc_7&amp;x=1">' +
      '<input type="hidden" name="javax.faces.ViewState" value="!token1"></form>';
    expect(parsePageState(html)).toEqual({
      action: '/fscmUI/faces/FuseWelcome?_adf.ctrl-state=abc_7&x=1',
      viewState: '!token1',
    });
  });

  test('returns null when the page has no ADF form', () => {
    expect(parsePageState('<html><body>Sign in</body></html>')).toBeNull();
  });
});

describe('parseRichResponse', () => {
  test('returns null for the answers a closed window gets', () => {
    expect(parseRichResponse('<?xml version="1.0" ?>\n<noop/>')).toBeNull();
    expect(
      parseRichResponse('<?xml version="1.0" ?>\n<?Adf-Rich-Response-Type ?>\n<redirect>/fscmUI/faces/x</redirect>'),
    ).toBeNull();
  });

  test('merges fragments into one document and restates the page state', () => {
    const response = parseRichResponse(
      envelope(
        '<fragment><![CDATA[<div id="a">one</div>]]></fragment>' +
          '<fragment><![CDATA[<span id="f1::postscript"><input type="hidden" name="javax.faces.ViewState" value="!token2"></span>]]></fragment>',
      ),
    );
    expect(response?.action).toBe('/fscmUI/faces/FuseWelcome?_adf.ctrl-state=abc_7&x=1');
    expect(response?.viewState).toBe('!token2');
    expect(response?.document.getElementById('a')?.textContent).toBe('one');
    expect(response?.messages).toEqual([]);
  });

  test('leaves the view state unset when the response does not restate it', () => {
    expect(parseRichResponse(envelope('<fragment><![CDATA[<div></div>]]></fragment>'))?.viewState).toBeNull();
  });

  test('ignores script-library elements and reads inline scripts', () => {
    const response = parseRichResponse(
      envelope('<script-library>/fscmUI/afr/x.js</script-library><script><![CDATA[var ready=1;]]></script>'),
    );
    expect(response?.scripts).toBe('var ready=1;');
  });

  test('reads a field-level error with its label', () => {
    const response = parseRichResponse(
      envelope(
        `<script><![CDATA[AdfPage.PAGE.clearSubtreeMessages('r:q1');AdfPage.PAGE.addMessage('r:q1:value10', ` +
          `new AdfFacesMessage(AdfFacesMessage.TYPE_ERROR,'Invalid value: X\\'1.','Invalid value: X\\'1.',null),' Item');]]></script>`,
      ),
    );
    expect(response?.messages).toEqual([{ severity: 'error', field: 'Item', text: "Invalid value: X'1." }]);
  });

  test('reads a page-level error that has no summary or label', () => {
    const response = parseRichResponse(
      envelope(
        '<script><![CDATA[AdfPage.PAGE.addMessage(null, new AdfFacesMessage(AdfFacesMessage.TYPE_ERROR,null,' +
          `'At least one of the following attributes is required.',null));]]></script>`,
      ),
    );
    expect(response?.messages).toEqual([
      { severity: 'error', field: '', text: 'At least one of the following attributes is required.' },
    ]);
  });

  test('reduces an application message wrapped in html to plain text', () => {
    const response = parseRichResponse(
      envelope(
        `<script><![CDATA[AdfPage.PAGE.addMessage(null, new AdfFacesMessage(AdfFacesMessage.TYPE_ERROR,null,'<html>Enter an <b>item</b>. (INV-1)</html>',null));]]></script>`,
      ),
    );
    expect(response?.messages[0]?.text).toBe('Enter an item. (INV-1)');
  });

  test('keeps the severity of non-error messages', () => {
    const response = parseRichResponse(
      envelope(
        `<script><![CDATA[AdfPage.PAGE.addMessage(null, new AdfFacesMessage(AdfFacesMessage.TYPE_WARNING,'Heads up','Heads up',null));]]></script>`,
      ),
    );
    expect(response?.messages[0]?.severity).toBe('warning');
  });
});
