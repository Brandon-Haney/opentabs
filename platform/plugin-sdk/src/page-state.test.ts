import { GlobalWindow } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getCurrentUrl, getPageGlobal, getPageTitle } from './page-state.js';

let win: GlobalWindow;

beforeEach(() => {
  win = new GlobalWindow({ url: 'https://example.com/page?q=1' });
  globalThis.document = win.document as unknown as Document;
  globalThis.window = win as unknown as Window & typeof globalThis;
});

afterEach(() => {
  // Clean up any test globals
  delete (globalThis as Record<string, unknown>).__testGlobal;
  delete (globalThis as Record<string, unknown>).__testProxy;
  delete (globalThis as Record<string, unknown>).TS;
  win.close();
});

// ---------------------------------------------------------------------------
// getPageGlobal
// ---------------------------------------------------------------------------

describe('getPageGlobal', () => {
  test('reads a shallow property from globalThis', () => {
    (globalThis as Record<string, unknown>).__testGlobal = 'hello';
    expect(getPageGlobal('__testGlobal')).toBe('hello');
  });

  test('reads a deeply nested property', () => {
    (globalThis as Record<string, unknown>).TS = {
      boot_data: { team_id: 'T123', api_token: 'xoxs-abc' },
    };
    expect(getPageGlobal('TS.boot_data.team_id')).toBe('T123');
    expect(getPageGlobal('TS.boot_data.api_token')).toBe('xoxs-abc');
  });

  test('returns undefined for missing intermediate property', () => {
    (globalThis as Record<string, unknown>).TS = {};
    expect(getPageGlobal('TS.boot_data.team_id')).toBeUndefined();
  });

  test('returns undefined for entirely missing path', () => {
    expect(getPageGlobal('nonExistentGlobal.foo.bar')).toBeUndefined();
  });

  test('returns undefined when an intermediate value is null', () => {
    (globalThis as Record<string, unknown>).TS = { boot_data: null };
    expect(getPageGlobal('TS.boot_data.team_id')).toBeUndefined();
  });

  test('returns undefined when an intermediate value is a primitive', () => {
    (globalThis as Record<string, unknown>).__testGlobal = 42;
    expect(getPageGlobal('__testGlobal.foo')).toBeUndefined();
  });

  test('returns the value when it is falsy but defined', () => {
    (globalThis as Record<string, unknown>).__testGlobal = { count: 0, flag: false, label: '' };
    expect(getPageGlobal('__testGlobal.count')).toBe(0);
    expect(getPageGlobal('__testGlobal.flag')).toBe(false);
    expect(getPageGlobal('__testGlobal.label')).toBe('');
  });

  test('returns undefined when a getter throws', () => {
    Object.defineProperty(globalThis, '__testGlobal', {
      get: () => {
        throw new Error('getter error');
      },
      configurable: true,
    });
    expect(getPageGlobal('__testGlobal.foo')).toBeUndefined();
  });

  test('returns undefined when a Proxy get-trap throws', () => {
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy get trap error');
        },
      },
    );
    (globalThis as Record<string, unknown>).__testProxy = throwingProxy;
    expect(getPageGlobal('__testProxy.anything')).toBeUndefined();
  });

  test('generic type parameter narrows return type', () => {
    (globalThis as Record<string, unknown>).TS = {
      boot_data: { api_token: 'xoxs-abc' },
    };
    const token = getPageGlobal('TS.boot_data.api_token') as string | undefined;
    expect(token).toBe('xoxs-abc');
  });

  test('returns unknown when called without cast', () => {
    (globalThis as Record<string, unknown>).__testGlobal = 42;
    const val = getPageGlobal('__testGlobal');
    expect(val).toBe(42);
  });

  test('returns undefined for missing path', () => {
    const result = getPageGlobal('nonExistent.deep.path');
    expect(result).toBeUndefined();
  });

  test('traverses through function-typed intermediate values', () => {
    const ctor = function SomeConstructor() {
      /* noop */
    } as unknown as Record<string, unknown>;
    ctor.config = { token: 'abc123' };
    (globalThis as Record<string, unknown>).SomeConstructor = ctor;
    expect(getPageGlobal('SomeConstructor.config.token')).toBe('abc123');
    delete (globalThis as Record<string, unknown>).SomeConstructor;
  });

  test('returns undefined for primitive intermediates after function traversal', () => {
    const ctor = function SomeLib() {
      /* noop */
    } as unknown as Record<string, unknown>;
    ctor.version = '1.0.0';
    (globalThis as Record<string, unknown>).SomeLib = ctor;
    expect(getPageGlobal('SomeLib.version.patch')).toBeUndefined();
    delete (globalThis as Record<string, unknown>).SomeLib;
  });

  describe('prototype chain blocking', () => {
    beforeEach(() => {
      (globalThis as Record<string, unknown>).TS = {
        boot_data: { api_token: 'xoxs-abc' },
      };
    });

    test('blocks __proto__ at the root', () => {
      expect(getPageGlobal('__proto__')).toBeUndefined();
    });

    test('blocks constructor at the root', () => {
      expect(getPageGlobal('constructor')).toBeUndefined();
    });

    test('blocks prototype at the root', () => {
      expect(getPageGlobal('prototype')).toBeUndefined();
    });

    test('blocks constructor.prototype', () => {
      expect(getPageGlobal('constructor.prototype')).toBeUndefined();
    });

    test('blocks __proto__.toString', () => {
      expect(getPageGlobal('__proto__.toString')).toBeUndefined();
    });

    test('blocks __proto__ mid-path (TS.__proto__.hasOwnProperty)', () => {
      expect(getPageGlobal('TS.__proto__.hasOwnProperty')).toBeUndefined();
    });

    test('still returns legitimate nested paths after blocking setup', () => {
      expect(getPageGlobal('TS.boot_data.api_token')).toBe('xoxs-abc');
    });

    test('returns undefined for empty string path', () => {
      expect(getPageGlobal('')).toBeUndefined();
    });

    test('returns undefined for path with consecutive dots (empty segment)', () => {
      expect(getPageGlobal('a..b')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// getCurrentUrl
// ---------------------------------------------------------------------------

describe('getCurrentUrl', () => {
  test('returns the current page URL', () => {
    expect(getCurrentUrl()).toBe('https://example.com/page?q=1');
  });
});

// ---------------------------------------------------------------------------
// getPageTitle
// ---------------------------------------------------------------------------

describe('getPageTitle', () => {
  test('returns the page title', () => {
    win.document.title = 'My Test Page';
    expect(getPageTitle()).toBe('My Test Page');
  });

  test('returns empty string when title is not set', () => {
    expect(getPageTitle()).toBe('');
  });
});
