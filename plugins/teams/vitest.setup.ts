import { beforeEach, vi } from 'vitest';

/**
 * Tests run with the browser's time zone pinned to America/Chicago, so the local
 * times the tools return read the same on every machine. The pin is applied
 * before each test because several test files restore all mocks afterwards.
 */
export const TEST_TIME_ZONE = 'America/Chicago';

const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

beforeEach(() => {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...resolvedOptions.call(this), timeZone: TEST_TIME_ZONE };
  });
});
