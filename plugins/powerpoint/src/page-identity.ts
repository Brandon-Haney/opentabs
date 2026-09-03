import { getPageGlobal } from '@opentabs-dev/plugin-sdk';

/**
 * Who the browser is on the open SharePoint page, read from the page's own
 * context globals (`_spPageContextInfo`, `_wopiContextJson`).
 *
 * - `member`: signed in to the tenant that hosts the file.
 * - `guest`: signed in as a B2B guest of the hosting tenant.
 * - `anonymous-link`: reached through an "anyone with the link" sharing link. No
 *   Microsoft 365 sign-in exists on such a page — SharePoint runs it as
 *   `urn:spo:tenantanon`, with no MSAL and no AAD user — so it never mints a
 *   Microsoft Graph token. Only the editor's own WOPI session reaches the file.
 * - `unknown`: the page exposes no identity context (the standalone cloud app,
 *   or a page that has not finished booting).
 */
export const PAGE_IDENTITY_KINDS = ['member', 'guest', 'anonymous-link', 'unknown'] as const;
export type PageIdentityKind = (typeof PAGE_IDENTITY_KINDS)[number];

export interface PageIdentity {
  kind: PageIdentityKind;
  /** Azure AD tenant hosting the page; null when the page exposes none. */
  tenantId: string | null;
  /**
   * Whether the WOPI host opened the file for editing (`WopiAction` is `Edit` and
   * the file is not `ReadOnly`); null when the page carries no WOPI context.
   */
  canEdit: boolean | null;
}

/** SharePoint's login-name prefix for a visitor who came in through an anonymous sharing link. */
const ANONYMOUS_LOGIN_PREFIX = 'urn:spo:tenantanon';

const readString = (path: string): string | null => {
  const value = getPageGlobal(path);
  return typeof value === 'string' && value !== '' ? value : null;
};

const readBoolean = (path: string): boolean | null => {
  const value = getPageGlobal(path);
  return typeof value === 'boolean' ? value : null;
};

const identityKind = (): PageIdentityKind => {
  const login = readString('_spPageContextInfo.userLoginName') ?? readString('_wopiContextJson.UserId');
  if (readBoolean('_spPageContextInfo.isAnonymousGuestUser') === true || login?.startsWith(ANONYMOUS_LOGIN_PREFIX)) {
    return 'anonymous-link';
  }
  if (readBoolean('_spPageContextInfo.isExternalGuestUser') === true) return 'guest';
  if (readString('_spPageContextInfo.aadUserId') !== null) return 'member';
  return 'unknown';
};

/** True when the page was reached through an anonymous sharing link and so can never hold a Graph token. */
export const isAnonymousLinkPage = (): boolean => identityKind() === 'anonymous-link';

/** The page identity, for diagnostics. */
export const describePageIdentity = (): PageIdentity => {
  const wopiAction = readString('_wopiContextJson.WopiAction');
  return {
    kind: identityKind(),
    tenantId: readString('_spPageContextInfo.aadTenantId') ?? readString('_wopiContextJson.TenantId'),
    canEdit:
      wopiAction === null
        ? null
        : wopiAction.toLowerCase() === 'edit' && readBoolean('_wopiContextJson.ReadOnly') !== true,
  };
};
