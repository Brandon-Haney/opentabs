import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as outlookApi from '../outlook-api.js';
import { findPeople } from './find-people.js';

vi.mock('../outlook-api.js', () => ({ api: vi.fn() }));

const api = vi.mocked(outlookApi.api);

beforeEach(() => {
  api.mockReset();
});

describe('find_people', () => {
  test('searches the people ranked for the user, in its own auth slot', async () => {
    api.mockResolvedValue({ value: [] });

    await findPeople.handle({ query: 'Bob "the builder" Sweeney' });

    expect(api).toHaveBeenCalledWith(
      '/me/people',
      {
        query: {
          $search: '"Bob the builder Sweeney"',
          $top: 10,
          $select: 'displayName,jobTitle,department,officeLocation,scoredEmailAddresses,personType',
        },
      },
      'people',
    );
  });

  test('returns each person with an address, and leaves out entries without one', async () => {
    api.mockResolvedValue({
      value: [
        {
          displayName: 'Bob Sweeney',
          jobTitle: 'Inventory Manager',
          department: 'Operations',
          officeLocation: 'Atlanta',
          scoredEmailAddresses: [{ address: 'Robert_Sweeney@contoso.com', relevanceScore: 9 }],
          personType: { class: 'Person', subclass: 'OrganizationUser' },
        },
        { displayName: 'Room 4', scoredEmailAddresses: [] },
        { displayName: 'Bobbie Lee', emailAddresses: [{ address: 'bobbie@contoso.com' }] },
      ],
    });

    const { people } = await findPeople.handle({ query: 'Bob', limit: 3 });

    expect(people).toEqual([
      {
        name: 'Bob Sweeney',
        address: 'Robert_Sweeney@contoso.com',
        job_title: 'Inventory Manager',
        department: 'Operations',
        office: 'Atlanta',
        source: 'OrganizationUser',
      },
      { name: 'Bobbie Lee', address: 'bobbie@contoso.com', job_title: '', department: '', office: '', source: '' },
    ]);
    expect(api.mock.calls[0]?.[1]?.query?.$top).toBe(3);
  });
});
