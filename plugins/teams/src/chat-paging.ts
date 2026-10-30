/**
 * Paging through the Chat Service. A response's `_metadata.backwardLink` is a URL for the
 * next, older page. Callers get only that URL's paging parameters as an opaque token, and
 * a token sent back contributes only those parameters to a request this plugin builds, so
 * a token can never point a signed request at another address.
 */

const PAGE_PARAMETERS = ['syncState', 'startTime', 'view'];

const pick = (params: URLSearchParams): URLSearchParams => {
  const picked = new URLSearchParams();
  for (const name of PAGE_PARAMETERS) {
    const value = params.get(name);
    if (value !== null) picked.set(name, value);
  }
  return picked;
};

/**
 * The token for the page after this one, or null on the last page. A page with no raw items
 * is the last even when it carries a link, because the service keeps offering one past the end.
 */
export const nextPageToken = (backwardLink: string | undefined, rawItemCount: number): string | null => {
  if (!backwardLink || rawItemCount === 0) return null;
  let params: URLSearchParams;
  try {
    params = new URL(backwardLink).searchParams;
  } catch {
    return null;
  }
  return params.has('syncState') ? pick(params).toString() : null;
};

/** The query parameters a token stands for. */
export const pageQuery = (token: string): Record<string, string> =>
  Object.fromEntries(pick(new URLSearchParams(token)));
