import { describe, expect, test } from 'vitest';
import {
  CSP_RELAY_DIRECTIVES,
  formatCspViolationLogLine,
  MAX_CSP_VIOLATIONS_PER_DOCUMENT,
  normalizeCspViolationReport,
  reduceSourceFile,
  reduceToOrigin,
} from './csp-violation.js';
import type { CspViolationReport } from './extension-messages.js';

const wellFormed = {
  effectiveDirective: 'connect-src',
  blockedURI: 'https://127.0.0.1:9515',
  sourceFile: 'chrome-extension://abc/adapters/outlook-1234abcd.js',
  lineNumber: 12,
  columnNumber: 34,
  disposition: 'enforce',
  documentOrigin: 'https://outlook.office.com',
};

describe('relay constants', () => {
  test('allow-list names the directives an adapter or pre-script can trip', () => {
    expect([...CSP_RELAY_DIRECTIVES]).toEqual([
      'connect-src',
      'require-trusted-types-for',
      'trusted-types',
      'script-src',
      'script-src-elem',
      'worker-src',
    ]);
  });

  test('per-document cap is 20', () => {
    expect(MAX_CSP_VIOLATIONS_PER_DOCUMENT).toBe(20);
  });
});

describe('reduceToOrigin', () => {
  test('reduces a URL with path and query to its origin', () => {
    expect(reduceToOrigin('https://outlook.office.com/mail/inbox/id/AAMk?x=1')).toBe('https://outlook.office.com');
  });

  test('keeps the port in the origin', () => {
    expect(reduceToOrigin('https://127.0.0.1:9515/mcp')).toBe('https://127.0.0.1:9515');
  });

  test('passes CSP keywords through unchanged', () => {
    expect(reduceToOrigin('inline')).toBe('inline');
    expect(reduceToOrigin('trusted-types-sink')).toBe('trusted-types-sink');
    expect(reduceToOrigin('')).toBe('');
  });

  test('truncates a non-URL string to 64 characters', () => {
    expect(reduceToOrigin('k'.repeat(100))).toBe('k'.repeat(64));
  });
});

describe('reduceSourceFile', () => {
  test('keeps a chrome-extension: source file in full', () => {
    expect(reduceSourceFile('chrome-extension://abc/adapters/outlook-1234abcd.js')).toBe(
      'chrome-extension://abc/adapters/outlook-1234abcd.js',
    );
  });

  test('reduces a page script URL to its origin', () => {
    expect(reduceSourceFile('https://outlook.office.com/mail/app.js')).toBe('https://outlook.office.com');
  });

  test('passes an empty source file through', () => {
    expect(reduceSourceFile('')).toBe('');
  });
});

describe('normalizeCspViolationReport', () => {
  test('returns the report for a well-formed input', () => {
    expect(normalizeCspViolationReport(wellFormed)).toEqual(wellFormed);
  });

  test('accepts the report-only disposition', () => {
    expect(normalizeCspViolationReport({ ...wellFormed, disposition: 'report' })?.disposition).toBe('report');
  });

  test('returns undefined for non-object inputs', () => {
    expect(normalizeCspViolationReport(null)).toBeUndefined();
    expect(normalizeCspViolationReport(undefined)).toBeUndefined();
    expect(normalizeCspViolationReport([wellFormed])).toBeUndefined();
    expect(normalizeCspViolationReport('connect-src')).toBeUndefined();
  });

  test('returns undefined when a required string field is missing or mistyped', () => {
    const { sourceFile: _sourceFile, ...missingSourceFile } = wellFormed;
    expect(normalizeCspViolationReport(missingSourceFile)).toBeUndefined();
    expect(normalizeCspViolationReport({ ...wellFormed, blockedURI: 42 })).toBeUndefined();
    expect(normalizeCspViolationReport({ ...wellFormed, documentOrigin: null })).toBeUndefined();
  });

  test('returns undefined for a disposition outside enforce/report', () => {
    expect(normalizeCspViolationReport({ ...wellFormed, disposition: 'block' })).toBeUndefined();
    expect(normalizeCspViolationReport({ ...wellFormed, disposition: undefined })).toBeUndefined();
  });

  test('returns undefined for a directive outside the relay allow-list', () => {
    expect(normalizeCspViolationReport({ ...wellFormed, effectiveDirective: 'img-src' })).toBeUndefined();
    expect(normalizeCspViolationReport({ ...wellFormed, effectiveDirective: 'style-src-elem' })).toBeUndefined();
  });

  test('accepts every allow-listed directive', () => {
    for (const directive of CSP_RELAY_DIRECTIVES) {
      expect(normalizeCspViolationReport({ ...wellFormed, effectiveDirective: directive })?.effectiveDirective).toBe(
        directive,
      );
    }
  });

  test('re-reduces blockedURI and documentOrigin to origins', () => {
    const report = normalizeCspViolationReport({
      ...wellFormed,
      blockedURI: 'https://127.0.0.1:9515/mcp?token=abc',
      documentOrigin: 'https://outlook.office.com/mail/inbox/id/AAMk',
    });
    expect(report?.blockedURI).toBe('https://127.0.0.1:9515');
    expect(report?.documentOrigin).toBe('https://outlook.office.com');
  });

  test('re-reduces a page-script sourceFile to its origin and keeps an extension file', () => {
    expect(
      normalizeCspViolationReport({ ...wellFormed, sourceFile: 'https://outlook.office.com/a.js' })?.sourceFile,
    ).toBe('https://outlook.office.com');
    expect(normalizeCspViolationReport(wellFormed)?.sourceFile).toBe(wellFormed.sourceFile);
  });

  test('truncates over-long strings to their caps', () => {
    const report = normalizeCspViolationReport({
      ...wellFormed,
      sourceFile: `chrome-extension://abc/${'a'.repeat(600)}`,
      blockedURI: 'x'.repeat(300),
    });
    expect(report?.sourceFile).toHaveLength(512);
    // A non-URL blockedURI is a keyword: capped at 64 by the origin reducer.
    expect(report?.blockedURI).toHaveLength(64);
  });

  test('coerces invalid line and column numbers to 0 and keeps valid ones', () => {
    expect(normalizeCspViolationReport({ ...wellFormed, lineNumber: Number.NaN })?.lineNumber).toBe(0);
    expect(normalizeCspViolationReport({ ...wellFormed, lineNumber: -1 })?.lineNumber).toBe(0);
    expect(normalizeCspViolationReport({ ...wellFormed, lineNumber: 1.5 })?.lineNumber).toBe(0);
    expect(normalizeCspViolationReport({ ...wellFormed, lineNumber: '12' })?.lineNumber).toBe(0);
    expect(normalizeCspViolationReport({ ...wellFormed, columnNumber: undefined })?.columnNumber).toBe(0);
    expect(normalizeCspViolationReport(wellFormed)?.lineNumber).toBe(12);
    expect(normalizeCspViolationReport(wellFormed)?.columnNumber).toBe(34);
  });

  test('drops unknown fields', () => {
    const report = normalizeCspViolationReport({ ...wellFormed, sample: 'secret', violatedDirective: 'x' });
    expect(report).toEqual(wellFormed);
  });
});

describe('formatCspViolationLogLine', () => {
  const report = wellFormed as CspViolationReport;

  test('names the tab, document origin, directive, blocked origin, source, and disposition', () => {
    expect(formatCspViolationLogLine(report, 7)).toBe(
      '[opentabs] CSP violation in tab 7 (https://outlook.office.com): connect-src blocked https://127.0.0.1:9515 ' +
        'from chrome-extension://abc/adapters/outlook-1234abcd.js:12 [enforce]',
    );
  });

  test('omits the source segment when the report has no source file', () => {
    expect(formatCspViolationLogLine({ ...report, sourceFile: '' }, 7)).toBe(
      '[opentabs] CSP violation in tab 7 (https://outlook.office.com): connect-src blocked https://127.0.0.1:9515 [enforce]',
    );
  });

  test('shows the report-only disposition and an unknown tab', () => {
    const line = formatCspViolationLogLine({ ...report, disposition: 'report' }, undefined);
    expect(line).toContain('in tab unknown');
    expect(line.endsWith('[report]')).toBe(true);
  });
});
