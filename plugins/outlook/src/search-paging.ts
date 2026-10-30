/**
 * Paging through message search. A response's `@odata.nextLink` is a URL for the next page.
 * Callers get only that URL's paging parameters as an opaque token, and a token sent back
 * contributes only those parameters to a request this plugin builds, so a token can never
 * point an authenticated request at another address or change the search.
 */

const PAGE_PARAMETERS = ['$skip', '$skiptoken'];

const pick = (params: URLSearchParams): URLSearchParams => {
  const picked = new URLSearchParams();
  for (const name of PAGE_PARAMETERS) {
    const value = params.get(name);
    if (value !== null) picked.set(name, value);
  }
  return picked;
};

/** The token for the page after this one, or null on the last page. */
export const nextPageToken = (nextLink: string | undefined, itemCount: number): string | null => {
  if (!nextLink || itemCount === 0) return null;
  let params: URLSearchParams;
  try {
    params = new URL(nextLink).searchParams;
  } catch {
    return null;
  }
  return pick(params).toString() || null;
};

/** The query parameters a token stands for. */
export const pageQuery = (token: string): Record<string, string> =>
  Object.fromEntries(pick(new URLSearchParams(token)));
