import { describe, expect, it } from 'vitest';
import { mapPermission } from './schemas.js';

describe('mapPermission', () => {
  it('maps a specific-people link with its grantees', () => {
    expect(
      mapPermission({
        id: 'link-1',
        roles: ['write'],
        link: { webUrl: 'https://contoso-my.sharepoint.com/:x:/g/abc', type: 'edit', scope: 'users' },
        grantedToIdentitiesV2: [
          {
            user: { displayName: 'Megan Bowen' },
            siteUser: { displayName: 'Megan Bowen', email: 'megan@contoso.com' },
          },
        ],
      }),
    ).toEqual({
      id: 'link-1',
      kind: 'link',
      roles: ['write'],
      link_url: 'https://contoso-my.sharepoint.com/:x:/g/abc',
      link_type: 'edit',
      link_scope: 'users',
      granted_to: [{ display_name: 'Megan Bowen', email: 'megan@contoso.com' }],
      inherited: false,
      expires_at: '',
    });
  });

  it('maps a direct grant from grantedToV2, ignoring grantedToIdentitiesV2', () => {
    const mapped = mapPermission({
      id: 'owner',
      roles: ['owner'],
      grantedToV2: { user: { displayName: 'Ellen Adams', email: 'ellen@contoso.com' } },
      grantedToIdentitiesV2: [{ user: { displayName: 'Someone Else' } }],
    });
    expect(mapped.kind).toBe('direct');
    expect(mapped.granted_to).toEqual([{ display_name: 'Ellen Adams', email: 'ellen@contoso.com' }]);
  });

  it('names a group grantee', () => {
    expect(
      mapPermission({ grantedToV2: { siteGroup: { displayName: 'Site Members' } }, inheritedFrom: {} }),
    ).toMatchObject({ granted_to: [{ display_name: 'Site Members', email: '' }], inherited: true });
  });

  it('adds a pending external invitee named only by email', () => {
    expect(
      mapPermission({ link: { scope: 'users', type: 'view' }, invitation: { email: 'guest@fabrikam.com' } }).granted_to,
    ).toEqual([{ display_name: '', email: 'guest@fabrikam.com' }]);
  });

  it('does not duplicate an invitee already listed as a grantee', () => {
    expect(
      mapPermission({
        grantedToIdentitiesV2: [{ user: { displayName: 'Guest', email: 'guest@fabrikam.com' } }],
        invitation: { email: 'guest@fabrikam.com' },
      }).granted_to,
    ).toHaveLength(1);
  });

  it('defaults an empty permission to a direct grant with nothing granted', () => {
    expect(mapPermission({})).toEqual({
      id: '',
      kind: 'direct',
      roles: [],
      link_url: '',
      link_type: '',
      link_scope: '',
      granted_to: [],
      inherited: false,
      expires_at: '',
    });
  });
});
