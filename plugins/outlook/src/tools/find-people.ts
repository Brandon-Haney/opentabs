import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../outlook-api.js';

const DEFAULT_LIMIT = 10;

const personSchema = z.object({
  name: z.string().describe('Display name'),
  address: z.string().describe('Email address'),
  job_title: z.string().describe('Job title (empty if unknown)'),
  department: z.string().describe('Department (empty if unknown)'),
  office: z.string().describe('Office location (empty if unknown)'),
  source: z
    .string()
    .describe(
      'Where the person was found: OrganizationUser (directory), PersonalContact, ImplicitContact (someone the user has corresponded with), or a group type',
    ),
});

interface RawPerson {
  displayName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  scoredEmailAddresses?: { address?: string }[];
  emailAddresses?: { address?: string }[];
  personType?: { class?: string; subclass?: string };
}

const mapPerson = (p: RawPerson): z.infer<typeof personSchema> | null => {
  const address = (p.scoredEmailAddresses ?? p.emailAddresses ?? []).find(email => email.address)?.address;
  if (!address) return null;
  return {
    name: p.displayName ?? '',
    address,
    job_title: p.jobTitle ?? '',
    department: p.department ?? '',
    office: p.officeLocation ?? '',
    source: p.personType?.subclass ?? p.personType?.class ?? '',
  };
};

export const findPeople = defineTool({
  name: 'find_people',
  displayName: 'Find People',
  description:
    "Look up people by name, or by part of an email address, to get their email addresses for get_schedule, invitations and messages. Searches the organization's directory and the user's contacts, ranked by how much the user works with each person, so the person meant usually comes first. Check the job title and department when a name matches more than one person.",
  summary: 'Find people by name',
  icon: 'user-search',
  group: 'People',
  input: z.object({
    query: z.string().trim().min(1).describe('Name or part of an email address, e.g. "Bob Sweeney" or "Sweeney"'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe(`Max people to return (default ${DEFAULT_LIMIT}, max 25)`),
  }),
  output: z.object({
    people: z.array(personSchema).describe('Matching people with an email address, most relevant first'),
  }),
  handle: async params => {
    // $search takes a quoted phrase, so quotes inside the query are dropped.
    const phrase = params.query.replace(/"/g, '');
    const data = await api<{ value?: RawPerson[] }>(
      '/me/people',
      {
        query: {
          $search: `"${phrase}"`,
          $top: params.limit ?? DEFAULT_LIMIT,
          $select: 'displayName,jobTitle,department,officeLocation,scoredEmailAddresses,personType',
        },
      },
      'people',
    );
    return { people: (data.value ?? []).flatMap(person => mapPerson(person) ?? []) };
  },
});
