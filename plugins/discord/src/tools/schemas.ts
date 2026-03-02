import { z } from 'zod';

// --- Discord data types ---

interface DiscordUser {
  id?: string;
  username?: string;
  discriminator?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

interface DiscordMessage {
  id?: string;
  channel_id?: string;
  author?: DiscordUser;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  type?: number;
  pinned?: boolean;
  thread?: { id?: string; name?: string };
}

interface DiscordChannel {
  id?: string;
  type?: number;
  guild_id?: string;
  name?: string;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  nsfw?: boolean;
}

interface DiscordGuild {
  id?: string;
  name?: string;
  icon?: string | null;
  owner?: boolean;
  owner_id?: string;
  member_count?: number;
  approximate_member_count?: number;
  description?: string | null;
}

// --- Zod schemas for tool outputs ---

export const userSchema = z.object({
  id: z.string().describe('User ID'),
  username: z.string().describe('Username'),
  global_name: z.string().nullable().describe('Display name'),
  avatar: z.string().nullable().describe('Avatar hash'),
  bot: z.boolean().describe('Whether the user is a bot'),
});

export const messageSchema = z.object({
  id: z.string().describe('Message ID'),
  channel_id: z.string().describe('Channel ID'),
  author: userSchema.describe('Message author'),
  content: z.string().describe('Message text content'),
  timestamp: z.string().describe('ISO 8601 timestamp'),
  edited_timestamp: z.string().nullable().describe('Edit timestamp or null'),
  pinned: z.boolean().describe('Whether the message is pinned'),
});

export const channelSchema = z.object({
  id: z.string().describe('Channel ID'),
  type: z.number().describe('Channel type (0=text, 2=voice, 4=category, 5=announcement, etc.)'),
  guild_id: z.string().describe('Guild ID'),
  name: z.string().describe('Channel name'),
  topic: z.string().nullable().describe('Channel topic'),
  position: z.number().describe('Sorting position'),
  parent_id: z.string().nullable().describe('Parent category ID'),
  nsfw: z.boolean().describe('Whether the channel is NSFW'),
});

export const guildSchema = z.object({
  id: z.string().describe('Guild (server) ID'),
  name: z.string().describe('Guild name'),
  icon: z.string().nullable().describe('Icon hash'),
  owner: z.boolean().describe('Whether the current user owns this guild'),
  description: z.string().nullable().describe('Guild description'),
  approximate_member_count: z.number().describe('Approximate member count'),
});

// --- Defensive mappers ---

export const mapUser = (u: Partial<DiscordUser> | undefined): z.infer<typeof userSchema> => ({
  id: u?.id ?? '',
  username: u?.username ?? '',
  global_name: u?.global_name ?? null,
  avatar: u?.avatar ?? null,
  bot: u?.bot ?? false,
});

export const mapMessage = (m: Partial<DiscordMessage> | undefined): z.infer<typeof messageSchema> => ({
  id: m?.id ?? '',
  channel_id: m?.channel_id ?? '',
  author: mapUser(m?.author),
  content: m?.content ?? '',
  timestamp: m?.timestamp ?? '',
  edited_timestamp: m?.edited_timestamp ?? null,
  pinned: m?.pinned ?? false,
});

export const mapChannel = (c: Partial<DiscordChannel> | undefined): z.infer<typeof channelSchema> => ({
  id: c?.id ?? '',
  type: c?.type ?? 0,
  guild_id: c?.guild_id ?? '',
  name: c?.name ?? '',
  topic: c?.topic ?? null,
  position: c?.position ?? 0,
  parent_id: c?.parent_id ?? null,
  nsfw: c?.nsfw ?? false,
});

export const mapGuild = (g: Partial<DiscordGuild> | undefined): z.infer<typeof guildSchema> => ({
  id: g?.id ?? '',
  name: g?.name ?? '',
  icon: g?.icon ?? null,
  owner: g?.owner ?? false,
  description: g?.description ?? null,
  approximate_member_count: g?.approximate_member_count ?? g?.member_count ?? 0,
});
