import { pluginNameFromPackage } from './discovery.js';
import { describe, expect, test } from 'bun:test';

describe('pluginNameFromPackage', () => {
  test('strips opentabs-plugin- prefix from unscoped package', () => {
    expect(pluginNameFromPackage('opentabs-plugin-slack')).toBe('slack');
  });

  test('handles scoped package @scope/opentabs-plugin-name', () => {
    expect(pluginNameFromPackage('@myorg/opentabs-plugin-jira')).toBe('myorg-jira');
  });

  test('handles scoped @opentabs-dev official package', () => {
    expect(pluginNameFromPackage('@opentabs-dev/opentabs-plugin-datadog')).toBe('opentabs-dev-datadog');
  });

  test('returns package name unchanged if no prefix', () => {
    expect(pluginNameFromPackage('some-other-package')).toBe('some-other-package');
  });

  test('handles scoped package without opentabs-plugin- prefix', () => {
    expect(pluginNameFromPackage('@myorg/custom-tool')).toBe('myorg-custom-tool');
  });

  test('handles multi-word plugin name', () => {
    expect(pluginNameFromPackage('opentabs-plugin-my-cool-tool')).toBe('my-cool-tool');
  });

  test('handles scoped package with multi-word name', () => {
    expect(pluginNameFromPackage('@company/opentabs-plugin-data-viewer')).toBe('company-data-viewer');
  });

  test('handles empty scope', () => {
    expect(pluginNameFromPackage('@/opentabs-plugin-test')).toBe('-test');
  });
});
