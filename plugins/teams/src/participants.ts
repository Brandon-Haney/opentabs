import { getDirectoryUsers, getGraphUserId, hasGraphToken, threadApi } from './teams-api.js';

/** Most untitled group chats one call looks up, since each costs a request. */
const MAX_GROUP_LOOKUPS = 10;

/** Most members named per chat; a chat this large is rarely left untitled. */
const MAX_NAMED_MEMBERS = 40;

/** The directory id in an organization user's MRI (`8:orgid:<id>`), or null for bots, guests and the like. */
export const directoryIdOfMri = (mri: string): string | null => /^8:orgid:([0-9a-f-]{36})$/i.exec(mri)?.[1] ?? null;

/** The two directory ids a one-on-one chat's id is built from (`19:<id>_<id>@unq.gbl.spaces`), or null. */
export const oneOnOneDirectoryIds = (conversationId: string): [string, string] | null => {
  const m = /^19:([0-9a-f-]{36})_([0-9a-f-]{36})@unq\.gbl\.spaces$/i.exec(conversationId);
  return m?.[1] && m[2] ? [m[1], m[2]] : null;
};

/**
 * Display names for directory ids. Ids the directory has no user for are absent. An unavailable
 * lookup (the Graph token arrives about a minute after a page load) yields null: a name is a
 * convenience on these reads, so it never fails or delays them.
 */
export const lookUpDisplayNames = async (directoryIds: string[]): Promise<Map<string, string> | null> => {
  if (!hasGraphToken()) return null;
  try {
    const users = await getDirectoryUsers([...new Set(directoryIds)]);
    return new Map(users.map(user => [user.id.toLowerCase(), user.displayName]));
  } catch {
    return null;
  }
};

/** A member's display name, or their MRI when the directory does not know them, so no member goes missing. */
export const memberLabel = (mri: string, names: Map<string, string>): string => {
  const id = directoryIdOfMri(mri);
  return (id && names.get(id.toLowerCase())) || mri;
};

const groupMemberMris = async (conversationId: string): Promise<string[]> => {
  const thread = await threadApi<{ members?: { id?: string }[] }>(conversationId, '?view=msnp24Equivalent');
  return (thread.members ?? []).flatMap(member => (member.id ? [member.id] : []));
};

/**
 * The other people in each untitled chat, for telling those chats apart: a one-on-one chat's
 * members come from its id, a group chat's from its thread. A chat is absent when it could not
 * be looked up. An empty map means names are unavailable right now.
 */
export const findChatParticipants = async (conversationIds: string[]): Promise<Map<string, string[]>> => {
  const result = new Map<string, string[]>();
  if (conversationIds.length === 0 || !hasGraphToken()) return result;

  const groups = conversationIds.filter(id => !oneOnOneDirectoryIds(id)).slice(0, MAX_GROUP_LOOKUPS);
  const groupMembers = new Map(
    await Promise.all(groups.map(async id => [id, await groupMemberMris(id).catch(() => null)] as const)),
  );

  const membersOf = (id: string): string[] | null => {
    const oneOnOne = oneOnOneDirectoryIds(id);
    if (oneOnOne) return oneOnOne.map(directoryId => `8:orgid:${directoryId}`);
    return groupMembers.get(id)?.slice(0, MAX_NAMED_MEMBERS) ?? null;
  };

  const directoryIds = conversationIds.flatMap(id => (membersOf(id) ?? []).flatMap(mri => directoryIdOfMri(mri) ?? []));
  const names = await lookUpDisplayNames(directoryIds);
  if (!names) return result;

  const self = getGraphUserId().toLowerCase();
  for (const id of conversationIds) {
    const members = membersOf(id);
    if (!members) continue;
    result.set(
      id,
      members.filter(mri => directoryIdOfMri(mri)?.toLowerCase() !== self).map(mri => memberLabel(mri, names)),
    );
  }
  return result;
};
