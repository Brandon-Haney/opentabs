import { detectDom } from './detect-dom.js';
import { describe, expect, test } from 'vitest';
import type { DomDetectionInput } from './detect-dom.js';

const emptyInput: DomDetectionInput = {
  forms: [],
  interactiveElements: [],
  dataAttributes: [],
};

describe('detectDom', () => {
  test('returns empty when no DOM data collected', () => {
    const result = detectDom(emptyInput);
    expect(result.forms).toEqual([]);
    expect(result.interactiveElements).toEqual([]);
    expect(result.dataAttributes).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Form detection
  // -----------------------------------------------------------------------

  describe('form detection', () => {
    test('detects a simple login form', () => {
      const result = detectDom({
        ...emptyInput,
        forms: [
          {
            action: '/login',
            method: 'POST',
            fields: [
              { name: 'username', type: 'text' },
              { name: 'password', type: 'password' },
            ],
          },
        ],
      });
      expect(result.forms).toHaveLength(1);
      expect(result.forms[0]?.action).toBe('/login');
      expect(result.forms[0]?.method).toBe('POST');
      expect(result.forms[0]?.fields).toHaveLength(2);
      expect(result.forms[0]?.fields[0]?.name).toBe('username');
      expect(result.forms[0]?.fields[0]?.type).toBe('text');
      expect(result.forms[0]?.fields[1]?.name).toBe('password');
      expect(result.forms[0]?.fields[1]?.type).toBe('password');
    });

    test('detects a form with hidden CSRF field', () => {
      const result = detectDom({
        ...emptyInput,
        forms: [
          {
            action: '/submit',
            method: 'POST',
            fields: [
              { name: '_token', type: 'hidden' },
              { name: 'message', type: 'textarea' },
            ],
          },
        ],
      });
      expect(result.forms).toHaveLength(1);
      expect(result.forms[0]?.fields).toHaveLength(2);
      expect(result.forms[0]?.fields[0]?.name).toBe('_token');
      expect(result.forms[0]?.fields[0]?.type).toBe('hidden');
    });

    test('detects multiple forms', () => {
      const result = detectDom({
        ...emptyInput,
        forms: [
          {
            action: '/search',
            method: 'GET',
            fields: [{ name: 'q', type: 'text' }],
          },
          {
            action: '/login',
            method: 'POST',
            fields: [
              { name: 'email', type: 'email' },
              { name: 'password', type: 'password' },
            ],
          },
        ],
      });
      expect(result.forms).toHaveLength(2);
      expect(result.forms[0]?.action).toBe('/search');
      expect(result.forms[1]?.action).toBe('/login');
    });

    test('detects form with select and textarea fields', () => {
      const result = detectDom({
        ...emptyInput,
        forms: [
          {
            action: '/feedback',
            method: 'POST',
            fields: [
              { name: 'category', type: 'select' },
              { name: 'comment', type: 'textarea' },
              { name: 'rating', type: 'number' },
            ],
          },
        ],
      });
      expect(result.forms).toHaveLength(1);
      expect(result.forms[0]?.fields).toHaveLength(3);
      expect(result.forms[0]?.fields[0]?.type).toBe('select');
      expect(result.forms[0]?.fields[1]?.type).toBe('textarea');
    });

    test('detects form with empty action', () => {
      const result = detectDom({
        ...emptyInput,
        forms: [
          {
            action: '',
            method: 'POST',
            fields: [{ name: 'data', type: 'text' }],
          },
        ],
      });
      expect(result.forms).toHaveLength(1);
      expect(result.forms[0]?.action).toBe('');
    });

    test('detects form with no fields', () => {
      const result = detectDom({
        ...emptyInput,
        forms: [
          {
            action: '/empty',
            method: 'GET',
            fields: [],
          },
        ],
      });
      expect(result.forms).toHaveLength(1);
      expect(result.forms[0]?.fields).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Interactive element detection
  // -----------------------------------------------------------------------

  describe('interactive element detection', () => {
    test('detects a button', () => {
      const result = detectDom({
        ...emptyInput,
        interactiveElements: [{ tag: 'button', type: 'submit', name: undefined, id: 'submit-btn', text: 'Submit' }],
      });
      expect(result.interactiveElements).toHaveLength(1);
      expect(result.interactiveElements[0]?.tag).toBe('button');
      expect(result.interactiveElements[0]?.type).toBe('submit');
      expect(result.interactiveElements[0]?.id).toBe('submit-btn');
      expect(result.interactiveElements[0]?.text).toBe('Submit');
    });

    test('detects an input field', () => {
      const result = detectDom({
        ...emptyInput,
        interactiveElements: [{ tag: 'input', type: 'text', name: 'search', id: 'search-input', text: undefined }],
      });
      expect(result.interactiveElements).toHaveLength(1);
      expect(result.interactiveElements[0]?.tag).toBe('input');
      expect(result.interactiveElements[0]?.name).toBe('search');
    });

    test('detects a select dropdown', () => {
      const result = detectDom({
        ...emptyInput,
        interactiveElements: [
          { tag: 'select', type: undefined, name: 'country', id: 'country-select', text: undefined },
        ],
      });
      expect(result.interactiveElements).toHaveLength(1);
      expect(result.interactiveElements[0]?.tag).toBe('select');
      expect(result.interactiveElements[0]?.name).toBe('country');
    });

    test('detects a link with onclick', () => {
      const result = detectDom({
        ...emptyInput,
        interactiveElements: [{ tag: 'a', type: undefined, name: undefined, id: 'action-link', text: 'Click me' }],
      });
      expect(result.interactiveElements).toHaveLength(1);
      expect(result.interactiveElements[0]?.tag).toBe('a');
      expect(result.interactiveElements[0]?.text).toBe('Click me');
    });

    test('detects multiple interactive elements', () => {
      const result = detectDom({
        ...emptyInput,
        interactiveElements: [
          { tag: 'button', type: 'button', name: undefined, id: 'btn-1', text: 'Save' },
          { tag: 'input', type: 'email', name: 'email', id: 'email-input', text: undefined },
          { tag: 'select', type: undefined, name: 'role', id: undefined, text: undefined },
          { tag: 'textarea', type: undefined, name: 'bio', id: 'bio-field', text: undefined },
        ],
      });
      expect(result.interactiveElements).toHaveLength(4);
    });

    test('limits interactive elements to 50', () => {
      const elements = Array.from({ length: 75 }, (_, i) => ({
        tag: 'button' as const,
        type: 'button' as const,
        name: undefined,
        id: `btn-${i}`,
        text: `Button ${i}`,
      }));

      const result = detectDom({
        ...emptyInput,
        interactiveElements: elements,
      });
      expect(result.interactiveElements).toHaveLength(50);
      expect(result.interactiveElements[0]?.id).toBe('btn-0');
      expect(result.interactiveElements[49]?.id).toBe('btn-49');
    });

    test('handles element with all undefined optional fields', () => {
      const result = detectDom({
        ...emptyInput,
        interactiveElements: [{ tag: 'button', type: undefined, name: undefined, id: undefined, text: undefined }],
      });
      expect(result.interactiveElements).toHaveLength(1);
      expect(result.interactiveElements[0]?.type).toBeUndefined();
      expect(result.interactiveElements[0]?.name).toBeUndefined();
      expect(result.interactiveElements[0]?.id).toBeUndefined();
      expect(result.interactiveElements[0]?.text).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Data attribute detection
  // -----------------------------------------------------------------------

  describe('data attribute detection', () => {
    test('reports unique data attribute names', () => {
      const result = detectDom({
        ...emptyInput,
        dataAttributes: ['data-testid', 'data-cy', 'data-action'],
      });
      expect(result.dataAttributes).toEqual(['data-action', 'data-cy', 'data-testid']);
    });

    test('deduplicates data attribute names', () => {
      const result = detectDom({
        ...emptyInput,
        dataAttributes: ['data-testid', 'data-cy', 'data-testid', 'data-cy', 'data-action'],
      });
      expect(result.dataAttributes).toEqual(['data-action', 'data-cy', 'data-testid']);
    });

    test('sorts data attribute names alphabetically', () => {
      const result = detectDom({
        ...emptyInput,
        dataAttributes: ['data-z-attr', 'data-a-attr', 'data-m-attr'],
      });
      expect(result.dataAttributes).toEqual(['data-a-attr', 'data-m-attr', 'data-z-attr']);
    });

    test('handles empty data attributes array', () => {
      const result = detectDom({
        ...emptyInput,
        dataAttributes: [],
      });
      expect(result.dataAttributes).toEqual([]);
    });

    test('reports common testing and framework data attributes', () => {
      const result = detectDom({
        ...emptyInput,
        dataAttributes: [
          'data-testid',
          'data-cy',
          'data-qa',
          'data-reactid',
          'data-component',
          'data-controller',
          'data-target',
        ],
      });
      expect(result.dataAttributes).toHaveLength(7);
      expect(result.dataAttributes).toContain('data-testid');
      expect(result.dataAttributes).toContain('data-controller');
    });
  });

  // -----------------------------------------------------------------------
  // Combined scenarios
  // -----------------------------------------------------------------------

  describe('combined scenarios', () => {
    test('real-world login page', () => {
      const result = detectDom({
        forms: [
          {
            action: '/auth/login',
            method: 'POST',
            fields: [
              { name: 'csrf_token', type: 'hidden' },
              { name: 'email', type: 'email' },
              { name: 'password', type: 'password' },
              { name: 'remember_me', type: 'checkbox' },
            ],
          },
        ],
        interactiveElements: [
          { tag: 'input', type: 'email', name: 'email', id: 'login-email', text: undefined },
          { tag: 'input', type: 'password', name: 'password', id: 'login-password', text: undefined },
          { tag: 'input', type: 'checkbox', name: 'remember_me', id: 'remember', text: undefined },
          { tag: 'button', type: 'submit', name: undefined, id: 'login-submit', text: 'Sign In' },
          { tag: 'a', type: undefined, name: undefined, id: 'forgot-password', text: 'Forgot password?' },
        ],
        dataAttributes: ['data-testid', 'data-form', 'data-action'],
      });

      expect(result.forms).toHaveLength(1);
      expect(result.forms[0]?.fields).toHaveLength(4);
      expect(result.interactiveElements).toHaveLength(5);
      expect(result.dataAttributes).toHaveLength(3);
    });

    test('real-world dashboard page', () => {
      const result = detectDom({
        forms: [
          {
            action: '/search',
            method: 'GET',
            fields: [{ name: 'q', type: 'text' }],
          },
        ],
        interactiveElements: [
          { tag: 'input', type: 'text', name: 'q', id: 'search-bar', text: undefined },
          { tag: 'button', type: 'button', name: undefined, id: 'new-item', text: 'New Item' },
          { tag: 'button', type: 'button', name: undefined, id: 'export', text: 'Export' },
          { tag: 'select', type: undefined, name: 'filter', id: 'filter-select', text: undefined },
          { tag: 'button', type: 'button', name: undefined, id: 'settings', text: 'Settings' },
        ],
        dataAttributes: ['data-id', 'data-status', 'data-row', 'data-sortable'],
      });

      expect(result.forms).toHaveLength(1);
      expect(result.interactiveElements).toHaveLength(5);
      expect(result.dataAttributes).toHaveLength(4);
      expect(result.dataAttributes).toEqual(['data-id', 'data-row', 'data-sortable', 'data-status']);
    });

    test('page with no forms but many interactive elements', () => {
      const result = detectDom({
        forms: [],
        interactiveElements: [
          { tag: 'button', type: 'button', name: undefined, id: 'play', text: 'Play' },
          { tag: 'button', type: 'button', name: undefined, id: 'pause', text: 'Pause' },
          { tag: 'button', type: 'button', name: undefined, id: 'next', text: 'Next' },
          { tag: 'input', type: 'range', name: 'volume', id: 'volume', text: undefined },
        ],
        dataAttributes: ['data-track-id', 'data-playlist'],
      });

      expect(result.forms).toEqual([]);
      expect(result.interactiveElements).toHaveLength(4);
      expect(result.dataAttributes).toHaveLength(2);
    });
  });
});
