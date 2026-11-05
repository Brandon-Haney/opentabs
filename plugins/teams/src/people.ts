import { ToolError, type ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { isEmailMention } from './chat-mentions.js';
import { directoryIdOfMri, lookUpDisplayNames } from './participants.js';
import { ensureGraphToken } from './reported-step.js';
import { type DirectoryUser, findDirectoryUsersByEmail } from './teams-api.js';

/**
 * People named in a tool's input: by email address, or by MRI as find_people,
 * get_conversation_details and read_messages report them. An organization
 * user's MRI is `8:orgid:` followed by their directory object id, so a bare
 * object id is taken as that MRI.
 */

export const personReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .describe('An email address (e.g. "name@example.com") or an MRI (e.g. "8:orgid:<id>") from find_people');

/** A person a tool acts on. */
export interface ResolvedPerson {
  mri: string;
  /** Display name, or null when the directory could not be asked. */
  name: string | null;
  email: string | null;
}

/** The MRI of an organization user, from their directory object id. */
export const orgMri = (directoryId: string): string => `8:orgid:${directoryId}`;

const OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a reference is an MRI: a numeric type prefix and a colon, as in `8:orgid:<id>` or `8:live:<name>`. */
const isMri = (reference: string): boolean => /^\d+:/.test(reference);

const fromDirectory = (user: DirectoryUser): ResolvedPerson => ({
  mri: orgMri(user.id),
  name: user.displayName,
  email: user.mail ?? user.userPrincipalName,
});

const matchesEmail = (user: DirectoryUser, email: string): boolean => {
  const wanted = email.toLowerCase();
  return user.mail?.toLowerCase() === wanted || user.userPrincipalName.toLowerCase() === wanted;
};

/**
 * Resolve each reference to a person, in order, without repeats. Email
 * addresses are looked up in the directory, which needs the Microsoft Graph
 * token (waited for while Teams renews it); MRIs and object ids are taken as
 * they are and named when the directory can be asked. Fails before any change
 * is made when a reference is neither, or when an address matches no one.
 */
export const resolvePeople = async (
  references: string[],
  context: ToolHandlerContext | undefined,
): Promise<ResolvedPerson[]> => {
  const unrecognized = references.filter(ref => !isEmailMention(ref) && !isMri(ref) && !OBJECT_ID_PATTERN.test(ref));
  if (unrecognized.length > 0) {
    throw ToolError.validation(
      `Name people by email address or MRI, not by name: ${unrecognized.map(ref => `"${ref}"`).join(', ')}. ` +
        'find_people looks up a name.',
    );
  }

  const emails = references.filter(isEmailMention);
  let found: DirectoryUser[] = [];
  if (emails.length > 0) {
    await ensureGraphToken(context);
    found = await findDirectoryUsersByEmail(emails);
    const missing = emails.filter(email => !found.some(user => matchesEmail(user, email)));
    if (missing.length > 0) {
      throw ToolError.notFound(
        `No one in your organization's directory has the email address ${missing.join(', ')}. ` +
          'Check the spelling, or look the person up with find_people.',
      );
    }
  }

  const mris = references.filter(ref => !isEmailMention(ref)).map(ref => (isMri(ref) ? ref : orgMri(ref)));
  const names = await lookUpDisplayNames(mris.flatMap(mri => directoryIdOfMri(mri) ?? []));

  const people = references.map((ref): ResolvedPerson => {
    if (isEmailMention(ref)) return fromDirectory(found.find(user => matchesEmail(user, ref)) as DirectoryUser);
    const mri = isMri(ref) ? ref : orgMri(ref);
    const id = directoryIdOfMri(mri);
    return { mri, name: (id && names?.get(id.toLowerCase())) || null, email: null };
  });
  const seen = new Set<string>();
  return people.filter(person => {
    const key = person.mri.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
