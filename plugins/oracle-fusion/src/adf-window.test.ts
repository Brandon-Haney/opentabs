import { describe, expect, test } from 'vitest';
import { eventFields } from './adf-window.js';

const STATE = { action: '/fscmUI/faces/FuseWelcome?_adf.ctrl-state=x_1', viewState: '!vs' };

describe('eventFields', () => {
  test('names the event, its payload and the component it is processed under', () => {
    expect(eventFields({ source: 'r:link', payload: '<m/>', fields: { 'r:q': 'A' } }, STATE)).toEqual({
      'r:q': 'A',
      'org.apache.myfaces.trinidad.faces.FORM': 'f1',
      'javax.faces.ViewState': '!vs',
      'oracle.adf.view.rich.RENDER': undefined,
      'oracle.adf.view.rich.DELTAS': undefined,
      event: 'r:link',
      'event.r:link': '<m/>',
      'oracle.adf.view.rich.PROCESS': 'r:link',
    });
  });

  test('fires the preceding events first, each under its own payload field', () => {
    const fields = eventFields(
      {
        source: 'r:t1:0:link',
        payload: '<action/>',
        preceding: [{ source: 'r:t1', payload: '<selection/>' }],
        process: 'r:t1,r:_ATp',
      },
      STATE,
    );
    expect(fields.event).toBe('r:t1,r:t1:0:link');
    expect(fields['event.r:t1']).toBe('<selection/>');
    expect(fields['event.r:t1:0:link']).toBe('<action/>');
    expect(fields['oracle.adf.view.rich.PROCESS']).toBe('r:t1,r:_ATp');
  });
});
