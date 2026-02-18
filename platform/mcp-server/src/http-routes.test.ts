import { checkBearerAuth, sweepStaleSessions } from './http-routes.js';
import { createState } from './state.js';
import { describe, expect, test } from 'bun:test';
import type { McpServerInstance } from './mcp-setup.js';

/** Create a minimal mock McpServerInstance */
const createMockSession = (): McpServerInstance => ({
  setRequestHandler: () => {},
  connect: () => Promise.resolve(),
  sendToolListChanged: () => Promise.resolve(),
});

describe('checkBearerAuth', () => {
  test('returns null when wsSecret is null (auth disabled)', () => {
    const req = new Request('http://localhost/mcp', { method: 'POST' });
    expect(checkBearerAuth(req, null)).toBeNull();
  });

  test('returns null when Bearer token matches wsSecret', () => {
    const secret = 'test-secret-123';
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(checkBearerAuth(req, secret)).toBeNull();
  });

  test('returns 401 when no Authorization header is present', () => {
    const req = new Request('http://localhost/mcp', { method: 'POST' });
    const res = checkBearerAuth(req, 'my-secret');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  test('returns 401 when Authorization header has wrong token', () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const res = checkBearerAuth(req, 'correct-secret');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  test('returns 401 when Authorization header uses non-Bearer scheme', () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    const res = checkBearerAuth(req, 'my-secret');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  test('returns 401 when Authorization header is "Bearer " with empty token', () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' },
    });
    const res = checkBearerAuth(req, 'my-secret');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });
});

describe('sweepStaleSessions', () => {
  test('sweeps session whose tracked transport ID is no longer in transports map', () => {
    const state = createState();
    const session = createMockSession();
    const transports = new Map<string, unknown>();
    const sessionServers = [session];

    // Track the session with a transport ID that is NOT in transports
    state.sessionTransportIds.set(session, 'transport-1');

    const swept = sweepStaleSessions(state, transports as Map<string, never>, sessionServers);

    expect(swept).toBe(1);
    expect(sessionServers).toHaveLength(0);
  });

  test('keeps session whose tracked transport ID IS in transports map', () => {
    const state = createState();
    const session = createMockSession();
    const transports = new Map<string, unknown>([['transport-1', {}]]);
    const sessionServers = [session];

    state.sessionTransportIds.set(session, 'transport-1');

    const swept = sweepStaleSessions(state, transports as Map<string, never>, sessionServers);

    expect(swept).toBe(0);
    expect(sessionServers).toHaveLength(1);
    expect(sessionServers[0]).toBe(session);
  });

  test('keeps untracked session when sessionServers count equals transports count', () => {
    const state = createState();
    const session = createMockSession();
    const transports = new Map<string, unknown>([['transport-1', {}]]);
    const sessionServers = [session];

    // No transport ID tracked for this session (predates tracking)

    const swept = sweepStaleSessions(state, transports as Map<string, never>, sessionServers);

    expect(swept).toBe(0);
    expect(sessionServers).toHaveLength(1);
  });

  test('keeps untracked sessions even when count exceeds transports', () => {
    const state = createState();
    const session1 = createMockSession();
    const session2 = createMockSession();
    const session3 = createMockSession();
    const transports = new Map<string, unknown>([['transport-1', {}]]);
    const sessionServers = [session1, session2, session3];

    // No transport IDs tracked — sessions may be in-flight (onsessioninitialized
    // hasn't fired yet), so they are preserved to avoid trimming valid sessions.

    const swept = sweepStaleSessions(state, transports as Map<string, never>, sessionServers);

    expect(swept).toBe(0);
    expect(sessionServers).toHaveLength(3);
  });

  test('sweeps only tracked-stale sessions, keeps untracked and tracked-live', () => {
    const state = createState();
    const trackedStale = createMockSession();
    const trackedLive = createMockSession();
    const untracked1 = createMockSession();
    const untracked2 = createMockSession();
    const transports = new Map<string, unknown>([['transport-live', {}]]);
    const sessionServers = [untracked1, trackedStale, trackedLive, untracked2];

    state.sessionTransportIds.set(trackedStale, 'transport-gone');
    state.sessionTransportIds.set(trackedLive, 'transport-live');

    const swept = sweepStaleSessions(state, transports as Map<string, never>, sessionServers);

    // Only trackedStale is swept (its transport ID is gone from transports).
    // untracked1, trackedLive, and untracked2 are all preserved.
    expect(swept).toBe(1);
    expect(sessionServers).toHaveLength(3);
    expect(sessionServers).toContain(untracked1);
    expect(sessionServers).toContain(trackedLive);
    expect(sessionServers).toContain(untracked2);
  });

  test('returns 0 when no sessions exist', () => {
    const state = createState();
    const transports = new Map<string, unknown>();
    const sessionServers: McpServerInstance[] = [];

    const swept = sweepStaleSessions(state, transports as Map<string, never>, sessionServers);

    expect(swept).toBe(0);
    expect(sessionServers).toHaveLength(0);
  });
});
