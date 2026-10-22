import { z } from 'zod';

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('User ID'),
  display_name: z.string().describe('Display name'),
  email: z.string().describe('Email address'),
});

export interface RawUser {
  id?: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

export const mapUser = (u: RawUser) => ({
  id: u.id ?? '',
  display_name: u.displayName ?? '',
  email: u.mail ?? u.userPrincipalName ?? '',
});

// --- Drive ---

export const quotaSchema = z.object({
  total: z.number().describe('Total storage in bytes'),
  used: z.number().describe('Used storage in bytes'),
  remaining: z.number().describe('Remaining storage in bytes'),
  state: z.string().describe('Quota state (normal, nearing, critical, exceeded)'),
});

export const driveSchema = z.object({
  id: z.string().describe('Drive ID'),
  name: z.string().describe('Drive name'),
  drive_type: z.string().describe('Drive type (personal, business, documentLibrary)'),
  quota: quotaSchema.describe('Storage quota information'),
});

export interface RawQuota {
  total?: number;
  used?: number;
  remaining?: number;
  state?: string;
}

export interface RawDrive {
  id?: string;
  name?: string;
  driveType?: string;
  quota?: RawQuota;
}

export const mapDrive = (d: RawDrive) => ({
  id: d.id ?? '',
  name: d.name ?? '',
  drive_type: d.driveType ?? '',
  quota: {
    total: d.quota?.total ?? 0,
    used: d.quota?.used ?? 0,
    remaining: d.quota?.remaining ?? 0,
    state: d.quota?.state ?? '',
  },
});

// --- Drive Item (file or folder) ---

export const driveItemSchema = z.object({
  id: z.string().describe('Item ID'),
  name: z.string().describe('File or folder name'),
  size: z.number().describe('Size in bytes (0 for folders)'),
  is_folder: z.boolean().describe('Whether the item is a folder'),
  mime_type: z.string().describe('MIME type (empty for folders)'),
  web_url: z.string().describe('URL to open in browser'),
  created_at: z.string().describe('ISO 8601 creation timestamp'),
  last_modified_at: z.string().describe('ISO 8601 last modification timestamp'),
  parent_path: z.string().describe('Parent folder path'),
  parent_id: z.string().describe('Parent folder ID'),
  description: z.string().describe('Item description'),
});

export interface RawDriveItem {
  id?: string;
  name?: string;
  size?: number;
  folder?: Record<string, unknown>;
  file?: { mimeType?: string; hashes?: Record<string, string> };
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  parentReference?: {
    driveId?: string;
    driveType?: string;
    id?: string;
    name?: string;
    path?: string;
  };
  description?: string;
}

export const mapDriveItem = (i: RawDriveItem) => ({
  id: i.id ?? '',
  name: i.name ?? '',
  size: i.size ?? 0,
  is_folder: !!i.folder,
  mime_type: i.file?.mimeType ?? '',
  web_url: i.webUrl ?? '',
  created_at: i.createdDateTime ?? '',
  last_modified_at: i.lastModifiedDateTime ?? '',
  parent_path: i.parentReference?.path ?? '',
  parent_id: i.parentReference?.id ?? '',
  description: i.description ?? '',
});

// --- Permission ---

export const permissionSchema = z.object({
  id: z.string().describe('Permission ID — pass it to update_permission or delete_permission'),
  kind: z
    .enum(['link', 'direct'])
    .describe('link: a sharing link; direct: access granted to specific people or groups by name'),
  roles: z.array(z.string()).describe('Granted roles: read (view), write (edit), or owner'),
  link_url: z.string().describe('Sharing link URL — empty for direct access'),
  link_type: z.string().describe('Link type: view, edit, or embed — empty for direct access'),
  link_scope: z
    .string()
    .describe(
      'Who the link works for: anonymous (anyone with it), organization (anyone signed in to the organization), ' +
        'or users (only the people in granted_to) — empty for direct access',
    ),
  granted_to: z
    .array(
      z.object({
        display_name: z.string().describe('Display name of the person or group'),
        email: z.string().describe('Email address — empty when Graph does not report one'),
      }),
    )
    .describe(
      'People or groups holding this access. For a link: the people it was shared with, or who have opened ' +
        'it; an anonymous link lists nobody',
    ),
  inherited: z
    .boolean()
    .describe('True when the access comes from a parent folder or the site, and can only be changed there'),
  expires_at: z.string().describe('ISO 8601 expiry — empty when the access does not expire'),
});

interface RawIdentity {
  displayName?: string;
  email?: string;
}

/** Graph identitySet / sharePointIdentitySet: whichever kinds of identity the grantee has. */
interface RawIdentitySet {
  user?: RawIdentity;
  siteUser?: RawIdentity;
  group?: RawIdentity;
  siteGroup?: RawIdentity;
}

export interface RawPermission {
  id?: string;
  roles?: string[];
  link?: { webUrl?: string; type?: string; scope?: string };
  grantedToV2?: RawIdentitySet;
  grantedToIdentitiesV2?: RawIdentitySet[];
  invitation?: { email?: string };
  inheritedFrom?: unknown;
  expirationDateTime?: string;
}

/**
 * One grantee. SharePoint reports a person as both an Entra `user` and a
 * `siteUser`, and only sometimes puts the email on the first, so the two are
 * merged field by field.
 */
const mapIdentity = (set: RawIdentitySet) => {
  const identities = [set.user, set.siteUser, set.group, set.siteGroup];
  return {
    display_name: identities.find(identity => identity?.displayName)?.displayName ?? '',
    email: identities.find(identity => identity?.email)?.email ?? '',
  };
};

export const mapPermission = (p: RawPermission) => {
  const grantees = p.grantedToV2 ? [p.grantedToV2] : (p.grantedToIdentitiesV2 ?? []);
  const granted_to = grantees.map(mapIdentity);
  // A pending invitation to someone outside the organization names them only by email.
  const invitedEmail = p.invitation?.email;
  if (invitedEmail && !granted_to.some(grantee => grantee.email === invitedEmail)) {
    granted_to.push({ display_name: '', email: invitedEmail });
  }
  return {
    id: p.id ?? '',
    kind: p.link ? ('link' as const) : ('direct' as const),
    roles: p.roles ?? [],
    link_url: p.link?.webUrl ?? '',
    link_type: p.link?.type ?? '',
    link_scope: p.link?.scope ?? '',
    granted_to,
    inherited: p.inheritedFrom !== undefined && p.inheritedFrom !== null,
    expires_at: p.expirationDateTime ?? '',
  };
};

/** Tool-facing access level, mapped onto Graph's `read` / `write` roles. */
export const accessRoleInput = z.enum(['view', 'edit']);

export const GRAPH_ROLE_FOR_ACCESS = { view: 'read', edit: 'write' } as const satisfies Record<
  z.infer<typeof accessRoleInput>,
  string
>;

// --- Version ---

export const versionSchema = z.object({
  id: z.string().describe('Version ID'),
  last_modified_at: z.string().describe('ISO 8601 last modification timestamp'),
  size: z.number().describe('Size in bytes'),
});

export interface RawVersion {
  id?: string;
  lastModifiedDateTime?: string;
  size?: number;
}

export const mapVersion = (v: RawVersion) => ({
  id: v.id ?? '',
  last_modified_at: v.lastModifiedDateTime ?? '',
  size: v.size ?? 0,
});
