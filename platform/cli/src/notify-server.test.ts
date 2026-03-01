import { notifyServer } from './notify-server.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('./config.js', () => ({
  readAuthSecret: vi.fn().mockResolvedValue(null),
}));

vi.mock('./parse-port.js', () => ({
  resolvePort: vi.fn().mockReturnValue(9515),
}));

describe('notifyServer', () => {
  let consoleSpy: MockInstance<typeof console.log>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  /** Build a health Response with the x-opentabs-version header (simulates OpenTabs server) */
  const opentabsHealthResponse = (): Response =>
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-opentabs-version': '0.0.1' },
    });

  /** Build a health Response without the x-opentabs-version header (simulates non-OpenTabs service) */
  const foreignHealthResponse = (): Response =>
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // OpenTabs identity verification
  // ---------------------------------------------------------------------------

  test('does not call /reload when health response has no x-opentabs-version header', async () => {
    fetchMock.mockResolvedValueOnce(foreignHealthResponse());

    await notifyServer({ warnIfNotRunning: false });

    // Only the health fetch was called — /reload was NOT called
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/health'), expect.anything());
  });

  test('logs "Server not running" when health response has no x-opentabs-version header and warnIfNotRunning is true', async () => {
    fetchMock.mockResolvedValueOnce(foreignHealthResponse());

    await notifyServer({ warnIfNotRunning: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Server not running — changes will apply on next start.'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not log when health response has no x-opentabs-version header and warnIfNotRunning is false', async () => {
    fetchMock.mockResolvedValueOnce(foreignHealthResponse());

    await notifyServer({ warnIfNotRunning: false });

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test('calls /reload when health response has x-opentabs-version header', async () => {
    fetchMock.mockResolvedValueOnce(opentabsHealthResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await notifyServer({});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reloadCall = fetchMock.mock.calls[1];
    expect(reloadCall?.[0]).toContain('/reload');
    expect(reloadCall?.[1]?.method).toBe('POST');
  });

  // ---------------------------------------------------------------------------
  // Health check failure cases
  // ---------------------------------------------------------------------------

  test('does not call /reload when health returns non-ok status', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

    await notifyServer({ warnIfNotRunning: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('logs "Server not running" when health returns non-ok status and warnIfNotRunning is true', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

    await notifyServer({ warnIfNotRunning: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Server not running — changes will apply on next start.'),
    );
  });

  test('does not call /reload when health fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await notifyServer({ warnIfNotRunning: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('logs "Server not running" when health fetch throws and warnIfNotRunning is true', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await notifyServer({ warnIfNotRunning: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Server not running — changes will apply on next start.'),
    );
  });

  // ---------------------------------------------------------------------------
  // /reload outcome logging
  // ---------------------------------------------------------------------------

  test('logs "Server notified." when /reload succeeds', async () => {
    fetchMock.mockResolvedValueOnce(opentabsHealthResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await notifyServer({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Server notified.'));
  });

  test('logs custom successMessage instead of "Server notified." when successMessage is provided', async () => {
    fetchMock.mockResolvedValueOnce(opentabsHealthResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await notifyServer({ successMessage: 'Server running on port 9515. Restart to apply port change.' });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Server running on port 9515. Restart to apply port change.'),
    );
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Server notified.'));
  });

  test('logs failure message when /reload returns non-ok status', async () => {
    fetchMock.mockResolvedValueOnce(opentabsHealthResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await notifyServer({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Could not notify server (HTTP 401)'));
  });

  test('logs failure message when /reload throws', async () => {
    fetchMock.mockResolvedValueOnce(opentabsHealthResponse());
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await notifyServer({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Could not notify server.'));
  });
});
