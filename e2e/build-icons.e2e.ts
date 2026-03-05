/**
 * E2E tests for plugin icon build validation and auto-generation.
 *
 * Verifies that `opentabs-plugin build` correctly validates SVGs,
 * auto-generates grayscale inactive variants, respects manual overrides,
 * and rejects invalid icons.
 *
 * Each test copies the e2e-test plugin to a temp directory, modifies icon
 * files, and runs the build as a subprocess.
 */

import type { ExecSyncOptions } from 'node:child_process';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { E2E_TEST_PLUGIN_DIR, expect, ROOT, symlinkCrossPlatform, test } from './fixtures.js';

// Path to the opentabs-plugin CLI entry point
const CLI_PATH = path.resolve(ROOT, 'platform/plugin-tools/dist/cli.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Copy the e2e-test plugin to a temp directory, excluding node_modules,
 * then symlinking node_modules from the original so the build can
 * resolve `@opentabs-dev/plugin-sdk`.
 */
const copyPlugin = (destDir: string): void => {
  fs.cpSync(E2E_TEST_PLUGIN_DIR, destDir, {
    recursive: true,
    filter: (src: string) => !src.includes('node_modules'),
  });
  symlinkCrossPlatform(path.join(E2E_TEST_PLUGIN_DIR, 'node_modules'), path.join(destDir, 'node_modules'), 'dir');
};

/**
 * Run `tsc && opentabs-plugin build` in the given plugin directory.
 * Returns exit code, stdout, and stderr.
 */
const runBuild = (pluginDir: string): { exitCode: number; stdout: string; stderr: string } => {
  const opts: ExecSyncOptions = {
    cwd: pluginDir,
    timeout: 60_000,
    env: { ...process.env, OPENTABS_CONFIG_DIR: os.tmpdir() },
  };

  // Compile TypeScript first
  try {
    execSync('npx tsc', opts);
  } catch (err: unknown) {
    const e = err as { status: number | null; stdout: Buffer | null; stderr: Buffer | null };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: `tsc failed: ${e.stderr?.toString() ?? ''}`,
    };
  }

  // Run the plugin build
  try {
    const stdout = execSync(`node ${CLI_PATH} build`, opts);
    return { exitCode: 0, stdout: stdout.toString(), stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number | null; stdout: Buffer | null; stderr: Buffer | null };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
};

/** Parse tools.json from a plugin dist directory */
const readToolsJson = (pluginDir: string): Record<string, unknown> => {
  const raw = fs.readFileSync(path.join(pluginDir, 'dist', 'tools.json'), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
};

/** A minimal, valid, square SVG icon with specified fills */
const makeSvg = (fills: string[], viewBox = '0 0 32 32'): string => {
  const rects = fills.map((fill, i) => `<rect x="${i * 8}" y="0" width="8" height="32" fill="${fill}"/>`).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">\n  ${rects}\n</svg>\n`;
};

/** Extract all hex color values from an SVG string */
const extractHexColors = (svg: string): string[] => {
  const matches = svg.match(/#[0-9a-fA-F]{6}/g) ?? [];
  return [...new Set(matches)];
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('plugin icon build validation', () => {
  let tmpDir: string;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentabs-icon-e2e-'));
  });

  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Successful builds
  // -------------------------------------------------------------------------

  test('valid icon.svg (no icon-inactive.svg) → auto-generates inactive variant', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    // Write a valid icon.svg and ensure no icon-inactive.svg
    fs.writeFileSync(path.join(pluginDir, 'icon.svg'), makeSvg(['#ff0000', '#00ff00', '#0000ff']));
    fs.rmSync(path.join(pluginDir, 'icon-inactive.svg'), { force: true });

    // Remove dist to force fresh build
    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode } = runBuild(pluginDir);
    expect(exitCode).toBe(0);

    const manifest = readToolsJson(pluginDir);
    expect(typeof manifest.iconSvg).toBe('string');
    expect(typeof manifest.iconInactiveSvg).toBe('string');

    // The inactive variant should contain only achromatic colors
    const inactiveSvg = manifest.iconInactiveSvg as string;
    const inactiveColors = extractHexColors(inactiveSvg);
    expect(inactiveColors.length).toBeGreaterThan(0);
    for (const color of inactiveColors) {
      const r = color.slice(1, 3);
      const g = color.slice(3, 5);
      const b = color.slice(5, 7);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });

  test('valid icon.svg + valid icon-inactive.svg → manual override used', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    // Active icon with colors
    fs.writeFileSync(path.join(pluginDir, 'icon.svg'), makeSvg(['#ff0000', '#00ff00']));
    // Manual inactive icon with achromatic colors
    fs.writeFileSync(path.join(pluginDir, 'icon-inactive.svg'), makeSvg(['#555555', '#aaaaaa']));

    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode } = runBuild(pluginDir);
    expect(exitCode).toBe(0);

    const manifest = readToolsJson(pluginDir);
    expect(typeof manifest.iconSvg).toBe('string');
    expect(typeof manifest.iconInactiveSvg).toBe('string');

    // The inactive SVG should contain the manually provided colors, not auto-generated
    const inactiveSvg = manifest.iconInactiveSvg as string;
    expect(inactiveSvg).toContain('#555555');
    expect(inactiveSvg).toContain('#aaaaaa');
  });

  test('no icon files → no icon fields in tools.json', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    // Remove both icon files
    fs.rmSync(path.join(pluginDir, 'icon.svg'), { force: true });
    fs.rmSync(path.join(pluginDir, 'icon-inactive.svg'), { force: true });

    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode } = runBuild(pluginDir);
    expect(exitCode).toBe(0);

    const manifest = readToolsJson(pluginDir);
    expect(manifest.iconSvg).toBeUndefined();
    expect(manifest.iconInactiveSvg).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Validation failures
  // -------------------------------------------------------------------------

  test('icon-inactive.svg without icon.svg → fails', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    // Remove icon.svg, add icon-inactive.svg
    fs.rmSync(path.join(pluginDir, 'icon.svg'), { force: true });
    fs.writeFileSync(path.join(pluginDir, 'icon-inactive.svg'), makeSvg(['#888888']));

    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode, stderr } = runBuild(pluginDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('icon.svg');
  });

  test('non-square viewBox in icon.svg → fails', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    fs.writeFileSync(path.join(pluginDir, 'icon.svg'), makeSvg(['#ff0000'], '0 0 32 24'));
    fs.rmSync(path.join(pluginDir, 'icon-inactive.svg'), { force: true });

    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode, stderr } = runBuild(pluginDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('viewBox');
  });

  test('oversized icon.svg (>8KB) → fails', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    // Generate an SVG with a very long path to exceed 8KB
    const longPath = `M0,0 ${'L10,10 '.repeat(1500)}`;
    const oversizedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="${longPath}" fill="#000"/></svg>`;
    expect(new TextEncoder().encode(oversizedSvg).byteLength).toBeGreaterThan(8192);

    fs.writeFileSync(path.join(pluginDir, 'icon.svg'), oversizedSvg);
    fs.rmSync(path.join(pluginDir, 'icon-inactive.svg'), { force: true });

    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode, stderr } = runBuild(pluginDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('size');
  });

  test('saturated colors in manual icon-inactive.svg → fails', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    fs.writeFileSync(path.join(pluginDir, 'icon.svg'), makeSvg(['#ff0000']));
    // Inactive icon with saturated color
    fs.writeFileSync(path.join(pluginDir, 'icon-inactive.svg'), makeSvg(['#ff0000']));

    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode, stderr } = runBuild(pluginDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('color');
  });

  test('<image> element in icon.svg → fails', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    const svgWithImage = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
      '  <image href="data:image/png;base64,AAA" width="32" height="32"/>',
      '</svg>',
    ].join('\n');
    fs.writeFileSync(path.join(pluginDir, 'icon.svg'), svgWithImage);
    fs.rmSync(path.join(pluginDir, 'icon-inactive.svg'), { force: true });

    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode, stderr } = runBuild(pluginDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('image');
  });

  // -------------------------------------------------------------------------
  // Auto-generation quality
  // -------------------------------------------------------------------------

  test('auto-generated inactive icon converts colors to achromatic grays with minimum clamp', () => {
    const pluginDir = path.join(tmpDir, 'e2e-test');
    copyPlugin(pluginDir);

    // Green (luminance ~182) is above the MIN_INACTIVE_GRAY clamp (153) and stays distinct.
    // Red (luminance ~54) and blue (luminance ~18) both clamp to #999999, producing 2 distinct grays.
    fs.writeFileSync(path.join(pluginDir, 'icon.svg'), makeSvg(['#ff0000', '#00ff00', '#0000ff']));
    fs.rmSync(path.join(pluginDir, 'icon-inactive.svg'), { force: true });

    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true });

    const { exitCode } = runBuild(pluginDir);
    expect(exitCode).toBe(0);

    const manifest = readToolsJson(pluginDir);
    const inactiveSvg = manifest.iconInactiveSvg as string;
    const grayColors = extractHexColors(inactiveSvg);

    // Red and blue both clamp to #999999; green stays at a higher gray → 2 distinct values
    expect(grayColors.length).toBe(2);

    // All should be achromatic
    for (const color of grayColors) {
      const r = color.slice(1, 3);
      const g = color.slice(3, 5);
      const b = color.slice(5, 7);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });
});
