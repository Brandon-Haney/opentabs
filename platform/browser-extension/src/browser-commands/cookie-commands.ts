import { requireStringParam, requireUrl, sendErrorResult, sendSuccessResult, sendValidationError } from './helpers.js';

/**
 * Retrieves cookies for a URL, optionally filtered by cookie name.
 * @param params - Expects `{ url: string, name?: string }`. Rejects blocked URL schemes.
 * @returns `{ cookies }` array with name, value, domain, path, secure, httpOnly, sameSite, and expirationDate.
 */
export const handleBrowserGetCookies = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const url = requireUrl(params, id);
    if (url === null) return;
    const filter: chrome.cookies.GetAllDetails = { url };
    const name = params.name;
    if (typeof name === 'string') {
      filter.name = name;
    }
    const cookies = await chrome.cookies.getAll(filter);
    sendSuccessResult(id, {
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      })),
    });
  } catch (err) {
    sendErrorResult(id, err);
  }
};

/**
 * Sets a cookie with the specified name, value, and optional attributes (domain, path, secure, httpOnly, expirationDate).
 * @param params - Expects `{ url: string, name: string, value: string, domain?: string, path?: string, secure?: boolean, httpOnly?: boolean, expirationDate?: number }`.
 * @returns The cookie as set by Chrome, including all resolved attributes.
 */
export const handleBrowserSetCookie = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const url = requireUrl(params, id);
    if (url === null) return;
    const name = requireStringParam(params, 'name', id);
    if (name === null) return;
    const value = params.value;
    if (typeof value !== 'string') {
      sendValidationError(id, 'Missing or invalid value parameter');
      return;
    }
    const details: chrome.cookies.SetDetails = { url, name, value };
    if (typeof params.domain === 'string') details.domain = params.domain;
    if (typeof params.path === 'string') details.path = params.path;
    if (typeof params.secure === 'boolean') details.secure = params.secure;
    if (typeof params.httpOnly === 'boolean') details.httpOnly = params.httpOnly;
    if (typeof params.expirationDate === 'number') details.expirationDate = params.expirationDate;
    const cookie = await chrome.cookies.set(details);
    if (!cookie) {
      sendErrorResult(id, new Error('Failed to set cookie'));
      return;
    }
    sendSuccessResult(id, {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
    });
  } catch (err) {
    sendErrorResult(id, err);
  }
};

export const handleBrowserDeleteCookies = async (
  params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const url = requireUrl(params, id);
    if (url === null) return;
    const name = requireStringParam(params, 'name', id);
    if (name === null) return;
    await chrome.cookies.remove({ url, name });
    sendSuccessResult(id, { deleted: true, name, url });
  } catch (err) {
    sendErrorResult(id, err);
  }
};
