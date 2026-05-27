import { z } from 'zod';

// --- Shared constants ---

export const DRIVE_ITEM_SELECT =
  'id,name,size,webUrl,file,folder,createdBy,createdDateTime,lastModifiedBy,lastModifiedDateTime';

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('User ID'),
  display_name: z.string().describe('Display name'),
  email: z.string().describe('Email address'),
});

interface RawUser {
  displayName?: string;
  email?: string;
  id?: string;
}

interface RawIdentity {
  user?: RawUser;
  application?: { displayName?: string; id?: string };
}

// --- Drive Item (file/folder) ---

export const driveItemSchema = z.object({
  id: z.string().describe('Item ID'),
  name: z.string().describe('File or folder name'),
  size: z.number().describe('Size in bytes'),
  web_url: z.string().describe('Web URL to open the item'),
  mime_type: z.string().describe('MIME type (empty for folders)'),
  is_folder: z.boolean().describe('Whether this item is a folder'),
  created_by: z.string().describe('Display name of the creator'),
  created_at: z.string().describe('ISO 8601 creation timestamp'),
  modified_by: z.string().describe('Display name of the last modifier'),
  modified_at: z.string().describe('ISO 8601 last modified timestamp'),
});

export interface RawDriveItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  createdBy?: RawIdentity;
  createdDateTime?: string;
  lastModifiedBy?: RawIdentity;
  lastModifiedDateTime?: string;
  '@microsoft.graph.downloadUrl'?: string;
}

export const mapDriveItem = (item: RawDriveItem) => ({
  id: item.id ?? '',
  name: item.name ?? '',
  size: item.size ?? 0,
  web_url: item.webUrl ?? '',
  mime_type: item.file?.mimeType ?? '',
  is_folder: !!item.folder,
  created_by: item.createdBy?.user?.displayName ?? '',
  created_at: item.createdDateTime ?? '',
  modified_by: item.lastModifiedBy?.user?.displayName ?? '',
  modified_at: item.lastModifiedDateTime ?? '',
});

// --- Drive (storage info) ---

export const driveSchema = z.object({
  id: z.string().describe('Drive ID'),
  name: z.string().describe('Drive name'),
  drive_type: z.string().describe('Drive type (personal, business, documentLibrary)'),
  total_bytes: z.number().describe('Total storage in bytes'),
  used_bytes: z.number().describe('Used storage in bytes'),
  remaining_bytes: z.number().describe('Remaining storage in bytes'),
  state: z.string().describe('Quota state (normal, nearing, critical, exceeded)'),
});

export interface RawDrive {
  id?: string;
  name?: string;
  driveType?: string;
  quota?: { total?: number; used?: number; remaining?: number; state?: string };
}

export const mapDrive = (d: RawDrive) => ({
  id: d.id ?? '',
  name: d.name ?? '',
  drive_type: d.driveType ?? '',
  total_bytes: d.quota?.total ?? 0,
  used_bytes: d.quota?.used ?? 0,
  remaining_bytes: d.quota?.remaining ?? 0,
  state: d.quota?.state ?? '',
});

// --- Version ---

export const versionSchema = z.object({
  id: z.string().describe('Version ID'),
  modified_by: z.string().describe('Display name of the modifier'),
  modified_at: z.string().describe('ISO 8601 timestamp'),
  size: z.number().describe('Version size in bytes'),
});

export interface RawVersion {
  id?: string;
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
  lastModifiedDateTime?: string;
  size?: number;
}

export const mapVersion = (v: RawVersion) => ({
  id: v.id ?? '',
  modified_by: v.lastModifiedBy?.user?.displayName ?? '',
  modified_at: v.lastModifiedDateTime ?? '',
  size: v.size ?? 0,
});

// --- Permission ---

export const permissionSchema = z.object({
  id: z.string().describe('Permission ID'),
  roles: z.array(z.string()).describe('Roles granted (read, write, owner)'),
  granted_to: z.string().describe('Display name of the grantee'),
  granted_to_email: z.string().describe('Email of the grantee'),
  link_url: z.string().describe('Sharing link URL (if link-based permission)'),
  link_type: z.string().describe('Link type (view, edit, embed) — empty if not a link'),
  link_scope: z.string().describe('Link scope (anonymous, organization, users) — empty if not a link'),
});

export interface RawPermission {
  id?: string;
  roles?: string[];
  grantedTo?: { user?: { displayName?: string; email?: string } };
  grantedToV2?: { siteUser?: { displayName?: string; email?: string } };
  link?: { webUrl?: string; type?: string; scope?: string };
}

export const mapPermission = (p: RawPermission) => ({
  id: p.id ?? '',
  roles: p.roles ?? [],
  granted_to: p.grantedTo?.user?.displayName ?? p.grantedToV2?.siteUser?.displayName ?? '',
  granted_to_email: p.grantedTo?.user?.email ?? p.grantedToV2?.siteUser?.email ?? '',
  link_url: p.link?.webUrl ?? '',
  link_type: p.link?.type ?? '',
  link_scope: p.link?.scope ?? '',
});

// --- Thumbnail ---

export const thumbnailSchema = z.object({
  url: z.string().describe('Thumbnail image URL'),
  width: z.number().describe('Width in pixels'),
  height: z.number().describe('Height in pixels'),
});

interface RawThumbnailSize {
  url?: string;
  width?: number;
  height?: number;
}

export interface RawThumbnailSet {
  large?: RawThumbnailSize;
  medium?: RawThumbnailSize;
  small?: RawThumbnailSize;
}

export const mapThumbnail = (t: RawThumbnailSize) => ({
  url: t.url ?? '',
  width: t.width ?? 0,
  height: t.height ?? 0,
});

// --- Graph collection response ---

export interface GraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

// --- Slide ---

export const slideSchema = z.object({
  number: z.number().int().describe('Slide number (1-indexed)'),
  file: z.string().describe('Internal file path within the PPTX archive'),
  texts: z.array(z.string()).describe('Text content extracted from the slide'),
  has_notes: z.boolean().describe('Whether this slide has speaker notes'),
});

// --- Slide layout (structural tree) ---

export const textRunSchema = z.object({
  text: z.string().describe('Run text content'),
  bold: z.boolean().optional().describe('Bold formatting'),
  italic: z.boolean().optional().describe('Italic formatting'),
  underline: z.boolean().optional().describe('Underline formatting'),
  size: z.number().optional().describe('Font size in points'),
  font: z.string().optional().describe('Font family name'),
  color: z.string().optional().describe('Hex color (e.g. "FFCC00") or "scheme:<name>" for theme colors'),
});

export const textParagraphSchema = z.object({
  runs: z.array(textRunSchema).describe('Formatted text runs within the paragraph'),
  align: z.enum(['left', 'center', 'right', 'justify']).optional().describe('Horizontal alignment'),
  level: z.number().int().optional().describe('Indent level (0 = top level)'),
});

export const shapeNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string().describe('Shape id, unique within the slide'),
    name: z.string().describe('Shape name from authoring tool'),
    kind: z
      .enum(['textbox', 'shape', 'placeholder', 'picture', 'group', 'table', 'chart', 'graphicFrame', 'connector'])
      .describe('Shape category'),
    preset: z.string().optional().describe('Preset geometry name for shapes ("rect", "ellipse", ...)'),
    placeholder_type: z.string().optional().describe('Placeholder type ("title", "body", "ctrTitle", ...)'),
    x: z.number().describe('X offset from slide top-left in inches'),
    y: z.number().describe('Y offset from slide top-left in inches'),
    w: z.number().describe('Width in inches'),
    h: z.number().describe('Height in inches'),
    rotation: z.number().optional().describe('Rotation in degrees (clockwise)'),
    fill: z.string().optional().describe('Solid fill color — hex or "scheme:<name>" for theme colors'),
    text: z.array(textParagraphSchema).optional().describe('Text content with per-run formatting'),
    image_rel: z.string().optional().describe('Relationship id of embedded image (picture shapes only)'),
    children: z.array(shapeNodeSchema).optional().describe('Child shapes for group shapes'),
    inherited_geometry: z
      .boolean()
      .optional()
      .describe('True when position/size are inherited from the slide layout/master'),
  }),
);

export const slideLayoutSchema = z.object({
  slide_number: z.number().int().describe('Slide number (1-indexed)'),
  width: z.number().describe('Slide canvas width in inches'),
  height: z.number().describe('Slide canvas height in inches'),
  shapes: z.array(shapeNodeSchema).describe('All top-level shapes on the slide'),
});
