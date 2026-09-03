import { afterEach, describe, expect, test } from 'vitest';
import { describePageIdentity, isAnonymousLinkPage } from './page-identity.js';

type PageGlobals = {
  _spPageContextInfo?: Record<string, unknown>;
  _wopiContextJson?: Record<string, unknown>;
};
const g = globalThis as PageGlobals;

afterEach(() => {
  delete g._spPageContextInfo;
  delete g._wopiContextJson;
});

describe('describePageIdentity', () => {
  test('a home-tenant user is a member, with the tenant and edit mode read from the page', () => {
    g._spPageContextInfo = { aadUserId: 'user-guid', aadTenantId: 'tenant-guid', isAnonymousGuestUser: false };
    g._wopiContextJson = { WopiAction: 'Edit', ReadOnly: false };
    expect(describePageIdentity()).toEqual({ kind: 'member', tenantId: 'tenant-guid', canEdit: true });
    expect(isAnonymousLinkPage()).toBe(false);
  });

  test('a B2B guest is a guest', () => {
    g._spPageContextInfo = { aadUserId: 'guest-guid', aadTenantId: 'tenant-guid', isExternalGuestUser: true };
    expect(describePageIdentity().kind).toBe('guest');
  });

  test('an anonymous sharing-link visitor is recognised by the flag, the login name, or the WOPI user id', () => {
    g._spPageContextInfo = { isAnonymousGuestUser: true, aadTenantId: 'host-tenant' };
    expect(describePageIdentity()).toEqual({ kind: 'anonymous-link', tenantId: 'host-tenant', canEdit: null });

    g._spPageContextInfo = { userLoginName: 'urn:spo:tenantanon#host-tenant', aadUserId: null };
    expect(isAnonymousLinkPage()).toBe(true);

    delete g._spPageContextInfo;
    g._wopiContextJson = { UserId: 'urn:spo:tenantanon#host-tenant', TenantId: 'host-tenant', WopiAction: 'Edit' };
    expect(describePageIdentity()).toEqual({ kind: 'anonymous-link', tenantId: 'host-tenant', canEdit: true });
  });

  test('a view-mode or read-only WOPI session cannot edit', () => {
    g._wopiContextJson = { WopiAction: 'View' };
    expect(describePageIdentity().canEdit).toBe(false);
    g._wopiContextJson = { WopiAction: 'Edit', ReadOnly: true };
    expect(describePageIdentity().canEdit).toBe(false);
  });

  test('a page without identity context is unknown', () => {
    expect(describePageIdentity()).toEqual({ kind: 'unknown', tenantId: null, canEdit: null });
    expect(isAnonymousLinkPage()).toBe(false);
  });
});
