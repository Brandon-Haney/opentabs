import {
  capitalizeFirst,
  deriveFormName,
  extractPathSegments,
  extractResourceName,
  extractTrpcProcedure,
  generateSuggestions,
  graphqlQuerySuggestions,
  httpMethodToVerb,
  restEndpointSuggestion,
  toSnakeCase,
} from './index.js';
import { describe, expect, test } from 'vitest';
import type { ApiAnalysis, ApiEndpoint } from './detect-apis.js';
import type { AuthAnalysis } from './detect-auth.js';
import type { DomAnalysis } from './detect-dom.js';
import type { FrameworkAnalysis } from './detect-framework.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyApis: ApiAnalysis = { endpoints: [], primaryApiBaseUrl: undefined };
const emptyDom: DomAnalysis = { forms: [], interactiveElements: [], dataAttributes: [] };
const emptyAuth: AuthAnalysis = { authenticated: false, methods: [] };
const emptyFramework: FrameworkAnalysis = { frameworks: [], isSPA: false, isSSR: false };

const endpoint = (overrides: Partial<ApiEndpoint> & { url: string; method: string }): ApiEndpoint => ({
  contentType: 'application/json',
  protocol: 'rest',
  authHeader: undefined,
  requestBodySample: undefined,
  responseStatus: 200,
  callCount: 1,
  wsFrameSamples: undefined,
  ...overrides,
});

// ---------------------------------------------------------------------------
// generateSuggestions
// ---------------------------------------------------------------------------

describe('generateSuggestions', () => {
  test('returns empty array for empty analysis', () => {
    const result = generateSuggestions(emptyApis, emptyDom, emptyAuth, emptyFramework);
    expect(result).toEqual([]);
  });

  test('REST endpoints produce tool suggestions', () => {
    const apis: ApiAnalysis = {
      endpoints: [endpoint({ url: 'https://example.com/api/users', method: 'GET' })],
      primaryApiBaseUrl: undefined,
    };
    const result = generateSuggestions(apis, emptyDom, emptyAuth, emptyFramework);
    expect(result).toHaveLength(1);
    expect(result[0]?.toolName).toBe('list_users');
  });

  test('GraphQL endpoint produces graphql_query suggestion', () => {
    const apis: ApiAnalysis = {
      endpoints: [endpoint({ url: 'https://example.com/graphql', method: 'POST', protocol: 'graphql' })],
      primaryApiBaseUrl: undefined,
    };
    const result = generateSuggestions(apis, emptyDom, emptyAuth, emptyFramework);
    expect(result.some(s => s.toolName === 'graphql_query')).toBe(true);
  });

  test('GraphQL endpoint with named operation produces named query suggestion', () => {
    const apis: ApiAnalysis = {
      endpoints: [
        endpoint({
          url: 'https://example.com/graphql',
          method: 'POST',
          protocol: 'graphql',
          requestBodySample: JSON.stringify({ query: 'query GetUser { user { id } }' }),
        }),
      ],
      primaryApiBaseUrl: undefined,
    };
    const result = generateSuggestions(apis, emptyDom, emptyAuth, emptyFramework);
    expect(result.some(s => s.toolName === 'gql_get_user')).toBe(true);
  });

  test('tRPC endpoints produce procedure suggestions', () => {
    const apis: ApiAnalysis = {
      endpoints: [endpoint({ url: 'https://example.com/api/trpc/user.list', method: 'GET', protocol: 'trpc' })],
      primaryApiBaseUrl: undefined,
    };
    const result = generateSuggestions(apis, emptyDom, emptyAuth, emptyFramework);
    expect(result.some(s => s.toolName === 'trpc_user_list')).toBe(true);
  });

  test('WebSocket endpoints produce subscribe_realtime suggestion', () => {
    const apis: ApiAnalysis = {
      endpoints: [endpoint({ url: 'wss://example.com/ws', method: 'GET', protocol: 'websocket' })],
      primaryApiBaseUrl: undefined,
    };
    const result = generateSuggestions(apis, emptyDom, emptyAuth, emptyFramework);
    expect(result.some(s => s.toolName === 'subscribe_realtime')).toBe(true);
  });

  test('JSON-RPC endpoints produce rpc_call suggestion', () => {
    const apis: ApiAnalysis = {
      endpoints: [endpoint({ url: 'https://example.com/rpc', method: 'POST', protocol: 'jsonrpc' })],
      primaryApiBaseUrl: undefined,
    };
    const result = generateSuggestions(apis, emptyDom, emptyAuth, emptyFramework);
    expect(result.some(s => s.toolName === 'rpc_call')).toBe(true);
  });

  test('forms with fields produce submit suggestions', () => {
    const dom: DomAnalysis = {
      forms: [
        {
          action: '/login',
          method: 'POST',
          fields: [
            { name: 'email', type: 'email' },
            { name: 'password', type: 'password' },
          ],
        },
      ],
      interactiveElements: [],
      dataAttributes: [],
    };
    const result = generateSuggestions(emptyApis, dom, emptyAuth, emptyFramework);
    expect(result.some(s => s.toolName.startsWith('submit_'))).toBe(true);
  });

  test('forms with no fields are not suggested', () => {
    const dom: DomAnalysis = {
      forms: [{ action: '/empty', method: 'POST', fields: [] }],
      interactiveElements: [],
      dataAttributes: [],
    };
    const result = generateSuggestions(emptyApis, dom, emptyAuth, emptyFramework);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// restEndpointSuggestion
// ---------------------------------------------------------------------------

describe('restEndpointSuggestion', () => {
  test('GET maps to list verb', () => {
    const result = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/posts', method: 'GET' }));
    expect(result?.toolName).toBe('list_posts');
  });

  test('POST maps to create verb', () => {
    const result = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/posts', method: 'POST' }));
    expect(result?.toolName).toBe('create_posts');
  });

  test('PUT maps to update verb', () => {
    const result = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/posts/123', method: 'PUT' }));
    expect(result?.toolName).toBe('update_posts');
  });

  test('PATCH maps to update verb', () => {
    const result = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/posts/123', method: 'PATCH' }));
    expect(result?.toolName).toBe('update_posts');
  });

  test('DELETE maps to delete verb', () => {
    const result = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/posts/123', method: 'DELETE' }));
    expect(result?.toolName).toBe('delete_posts');
  });

  test('skips version and api prefix segments to find resource name', () => {
    const result = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/v1/items/456', method: 'GET' }));
    expect(result?.toolName).toBe('list_items');
  });

  test('returns undefined when path has only reserved or ID segments', () => {
    const result = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/v1/12345', method: 'GET' }));
    expect(result).toBeUndefined();
  });

  test('description includes method and resource', () => {
    const result = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/users', method: 'GET' }));
    expect(result?.description).toContain('GET');
    expect(result?.description).toContain('users');
  });

  test('GET has low complexity, non-GET has medium complexity', () => {
    const get = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/users', method: 'GET' }));
    const post = restEndpointSuggestion(endpoint({ url: 'https://example.com/api/users', method: 'POST' }));
    expect(get?.complexity).toBe('low');
    expect(post?.complexity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// graphqlQuerySuggestions
// ---------------------------------------------------------------------------

describe('graphqlQuerySuggestions', () => {
  test('returns empty for endpoint without requestBodySample', () => {
    const result = graphqlQuerySuggestions(endpoint({ url: 'https://example.com/graphql', method: 'POST' }));
    expect(result).toEqual([]);
  });

  test('returns empty for non-JSON requestBodySample', () => {
    const result = graphqlQuerySuggestions(
      endpoint({ url: 'https://example.com/graphql', method: 'POST', requestBodySample: 'not json' }),
    );
    expect(result).toEqual([]);
  });

  test('returns empty when query body lacks operation name', () => {
    const result = graphqlQuerySuggestions(
      endpoint({
        url: 'https://example.com/graphql',
        method: 'POST',
        requestBodySample: JSON.stringify({ query: '{ user { id } }' }),
      }),
    );
    expect(result).toEqual([]);
  });

  test('extracts named query operation', () => {
    const result = graphqlQuerySuggestions(
      endpoint({
        url: 'https://example.com/graphql',
        method: 'POST',
        requestBodySample: JSON.stringify({ query: 'query GetUserProfile { user { id name } }' }),
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.toolName).toBe('gql_get_user_profile');
    expect(result[0]?.description).toContain('GetUserProfile');
  });

  test('extracts mutation operation and labels as Execute', () => {
    const result = graphqlQuerySuggestions(
      endpoint({
        url: 'https://example.com/graphql',
        method: 'POST',
        requestBodySample: JSON.stringify({
          query: 'mutation CreatePost($input: PostInput!) { createPost(input: $input) { id } }',
        }),
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.toolName).toBe('gql_create_post');
    expect(result[0]?.description).toMatch(/Execute/);
  });

  test('returns empty for JSON without query field', () => {
    const result = graphqlQuerySuggestions(
      endpoint({
        url: 'https://example.com/graphql',
        method: 'POST',
        requestBodySample: JSON.stringify({ variables: { id: 1 } }),
      }),
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractTrpcProcedure
// ---------------------------------------------------------------------------

describe('extractTrpcProcedure', () => {
  test('extracts procedure from /api/trpc/ URL', () => {
    expect(extractTrpcProcedure('https://example.com/api/trpc/user.getById')).toBe('user.getById');
  });

  test('extracts procedure from /trpc/ URL', () => {
    expect(extractTrpcProcedure('https://example.com/trpc/post.list')).toBe('post.list');
  });

  test('returns undefined for non-tRPC URL', () => {
    expect(extractTrpcProcedure('https://example.com/api/users')).toBeUndefined();
  });

  test('returns undefined for invalid URL', () => {
    expect(extractTrpcProcedure('not a url')).toBeUndefined();
  });

  test('handles simple procedure name', () => {
    expect(extractTrpcProcedure('https://example.com/trpc/health')).toBe('health');
  });
});

// ---------------------------------------------------------------------------
// deriveFormName
// ---------------------------------------------------------------------------

describe('deriveFormName', () => {
  test('derives name from action URL last path segment', () => {
    expect(deriveFormName({ action: 'https://example.com/api/register', fields: [] })).toBe('register');
  });

  test('converts camelCase action path segment to snake_case', () => {
    expect(deriveFormName({ action: '/submitOrder', fields: [] })).toBe('submit_order');
  });

  test('falls back to login when email and password fields are present', () => {
    expect(deriveFormName({ action: '', fields: [{ name: 'email' }, { name: 'password' }] })).toBe('login');
  });

  test('falls back to auth when only password field is present', () => {
    expect(deriveFormName({ action: '', fields: [{ name: 'password' }] })).toBe('auth');
  });

  test('falls back to search when search field is present', () => {
    expect(deriveFormName({ action: '', fields: [{ name: 'search_query' }] })).toBe('search');
  });

  test('falls back to form as generic default', () => {
    expect(deriveFormName({ action: '', fields: [{ name: 'message' }] })).toBe('form');
  });
});

// ---------------------------------------------------------------------------
// extractPathSegments
// ---------------------------------------------------------------------------

describe('extractPathSegments', () => {
  test('extracts pathname from full URL', () => {
    expect(extractPathSegments('https://example.com/api/users')).toBe('/api/users');
  });

  test('returns undefined for invalid URL', () => {
    expect(extractPathSegments('not a url')).toBeUndefined();
  });

  test('returns root path for URL with no path', () => {
    expect(extractPathSegments('https://example.com')).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// extractResourceName
// ---------------------------------------------------------------------------

describe('extractResourceName', () => {
  test('extracts resource from simple path', () => {
    expect(extractResourceName('/api/users')).toBe('users');
  });

  test('skips api and version prefix segments', () => {
    expect(extractResourceName('/api/v1/items')).toBe('items');
  });

  test('skips numeric ID segments', () => {
    expect(extractResourceName('/api/orders/12345')).toBe('orders');
  });

  test('skips UUID segments', () => {
    expect(extractResourceName('/api/posts/550e8400-e29b-41d4-a716-446655440000')).toBe('posts');
  });

  test('returns undefined for path with only reserved segments', () => {
    expect(extractResourceName('/api/v1')).toBeUndefined();
  });

  test('converts hyphens to underscores via toSnakeCase', () => {
    expect(extractResourceName('/api/user-profiles')).toBe('user_profiles');
  });
});

// ---------------------------------------------------------------------------
// httpMethodToVerb
// ---------------------------------------------------------------------------

describe('httpMethodToVerb', () => {
  test('GET → list', () => expect(httpMethodToVerb('GET')).toBe('list'));
  test('POST → create', () => expect(httpMethodToVerb('POST')).toBe('create'));
  test('PUT → update', () => expect(httpMethodToVerb('PUT')).toBe('update'));
  test('PATCH → update', () => expect(httpMethodToVerb('PATCH')).toBe('update'));
  test('DELETE → delete', () => expect(httpMethodToVerb('DELETE')).toBe('delete'));
  test('unknown method returns lowercased method', () => expect(httpMethodToVerb('HEAD')).toBe('head'));
  test('lowercase input is normalized before matching', () => expect(httpMethodToVerb('get')).toBe('list'));
});

// ---------------------------------------------------------------------------
// toSnakeCase
// ---------------------------------------------------------------------------

describe('toSnakeCase', () => {
  test('camelCase → snake_case', () => expect(toSnakeCase('camelCase')).toBe('camel_case'));
  test('PascalCase → snake_case', () => expect(toSnakeCase('GetUserProfile')).toBe('get_user_profile'));
  test('hyphen-separated → underscore-separated', () => expect(toSnakeCase('user-profile')).toBe('user_profile'));
  test('space-separated → underscore-separated', () => expect(toSnakeCase('user profile')).toBe('user_profile'));
  test('already snake_case is unchanged', () => expect(toSnakeCase('snake_case')).toBe('snake_case'));
  test('empty string returns empty', () => expect(toSnakeCase('')).toBe(''));
});

// ---------------------------------------------------------------------------
// capitalizeFirst
// ---------------------------------------------------------------------------

describe('capitalizeFirst', () => {
  test('capitalizes first letter of lowercase string', () => expect(capitalizeFirst('hello')).toBe('Hello'));
  test('empty string returns empty', () => expect(capitalizeFirst('')).toBe(''));
  test('already capitalized string is unchanged', () => expect(capitalizeFirst('Hello')).toBe('Hello'));
  test('single character is capitalized', () => expect(capitalizeFirst('a')).toBe('A'));
});
