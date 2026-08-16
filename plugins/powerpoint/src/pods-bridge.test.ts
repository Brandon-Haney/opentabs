import { describe, expect, test } from 'vitest';
import {
  PODS_GUID_TOKEN,
  PODS_HEAD_TOKEN,
  type PodsActionDirective,
  podsAddSlide,
  podsDeleteSlide,
  podsFormatText,
  podsOpenEditor,
  podsReadOutline,
  podsSetFontSize,
  podsWrite,
} from './pods-bridge.js';

const MODEL_READ_BODY =
  '{"Mode":4,"srs":[[2,{"OperationId":1,"DependentOn":0,"ExpectedLatestRevisionId":"00000000-0000-0000-0000-000000000000|0","SlideId":null,"Sequence":0,"LocalRenderingParams":null}]]}';

/** The common `__podsAction` envelope every action builder must emit. */
const commonAction = {
  v: 1,
  frameUrlIncludes: 'powerpoint.officeapps.live.com',
  donorGlobal: '__otbPptPodsDonor',
  headSentinel: '__otb_pods_head__',
  modelReadBody: MODEL_READ_BODY,
  guidToken: PODS_GUID_TOKEN,
  headToken: PODS_HEAD_TOKEN,
};

const actionOf = (directive: unknown): PodsActionDirective['__podsAction'] =>
  (directive as unknown as PodsActionDirective).__podsAction;

describe('podsWrite', () => {
  const body = { Mode: 4, srs: [[3, { Revisions: [{ Id: `${PODS_GUID_TOKEN}|2`, BaseId: PODS_HEAD_TOKEN }] }]] };

  test('wraps the body in a __podsBridge directive with the PowerPoint frame/donor/sentinel', () => {
    const directive = podsWrite(body) as unknown as { __podsBridge: Record<string, unknown> };
    expect(directive.__podsBridge).toEqual({
      frameUrlIncludes: 'powerpoint.officeapps.live.com',
      donorGlobal: '__otbPptPodsDonor',
      headSentinel: '__otb_pods_head__',
      body,
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    });
  });

  test('passes the body through by reference, tokens intact for the engine to substitute', () => {
    const directive = podsWrite(body) as unknown as { __podsBridge: { body: unknown } };
    expect(directive.__podsBridge.body).toBe(body);
    expect(JSON.stringify(directive.__podsBridge.body)).toContain(PODS_GUID_TOKEN);
    expect(JSON.stringify(directive.__podsBridge.body)).toContain(PODS_HEAD_TOKEN);
  });

  test('the identity tokens are distinctive and JSON-safe (no quotes or backslashes)', () => {
    for (const token of [PODS_GUID_TOKEN, PODS_HEAD_TOKEN]) {
      expect(token).toMatch(/^__OTB_PODS_[A-Z]+__$/);
      expect(JSON.stringify(token)).toBe(`"${token}"`);
    }
  });
});

describe('pods action directives', () => {
  test('podsSetFontSize names the set_font_size action with the target and size as args', () => {
    const action = actionOf(podsSetFontSize('Workstream', 24));
    expect(action).toMatchObject({
      ...commonAction,
      action: 'set_font_size',
      args: { text: 'Workstream', sizePt: 24 },
    });
    expect(action.errorHints).toBeDefined();
  });

  test('podsFormatText carries only the requested changes in args', () => {
    const action = actionOf(podsFormatText('Title', { sizePt: 28, bold: true }));
    expect(action.action).toBe('format_text');
    expect(action.args).toEqual({ text: 'Title', sizePt: 28, bold: true });
    expect('italic' in action.args).toBe(false);
  });

  test('podsAddSlide has no args and carries dryRun at the directive level', () => {
    expect(actionOf(podsAddSlide())).toMatchObject({ action: 'add_slide', args: {}, dryRun: false });
    expect(actionOf(podsAddSlide(true)).dryRun).toBe(true);
  });

  test('podsDeleteSlide carries the 1-based index and dryRun', () => {
    const action = actionOf(podsDeleteSlide(3));
    expect(action).toMatchObject({ action: 'delete_slide', args: { slideIndex: 3 }, dryRun: false });
    expect(actionOf(podsDeleteSlide(2, true)).dryRun).toBe(true);
  });

  test('podsReadOutline is a plain read with no args and no dryRun', () => {
    const action = actionOf(podsReadOutline());
    expect(action).toMatchObject({ action: 'read_outline', args: {} });
    expect('dryRun' in action).toBe(false);
  });

  test('every action declares contract v1 and passes the decoded error hints through', () => {
    for (const directive of [podsSetFontSize('t', 10), podsAddSlide(), podsDeleteSlide(1), podsReadOutline()]) {
      const action = actionOf(directive);
      expect(action.v).toBe(1);
      expect(Object.keys(action.errorHints).length).toBeGreaterThan(0);
    }
  });
});

describe('podsOpenEditor', () => {
  test('builds a __podsOpenEditor directive with the URL and session markers', () => {
    const directive = podsOpenEditor('https://contoso-my.sharepoint.com/:p:/r/x.pptx') as unknown as {
      __podsOpenEditor: Record<string, unknown>;
    };
    expect(directive.__podsOpenEditor).toEqual({
      url: 'https://contoso-my.sharepoint.com/:p:/r/x.pptx',
      frameUrlIncludes: 'powerpoint.officeapps.live.com',
      donorGlobal: '__otbPptPodsDonor',
    });
  });

  test('carries an explicit wait through in milliseconds', () => {
    const directive = podsOpenEditor('https://contoso-my.sharepoint.com/:p:/r/x.pptx', 90_000) as unknown as {
      __podsOpenEditor: { waitMs?: number };
    };
    expect(directive.__podsOpenEditor.waitMs).toBe(90_000);
  });
});
