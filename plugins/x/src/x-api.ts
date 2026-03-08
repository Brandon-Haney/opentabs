import { ToolError, parseRetryAfterMs } from '@opentabs-dev/plugin-sdk';

/** Static bearer token for X web client — same for all users, embedded in the JS bundle. */
const BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const GRAPHQL_BASE = 'https://x.com/i/api/graphql';

/** Standard feature flags required by most GraphQL operations. */
const DEFAULT_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

/** Feature flags for user profile queries. */
const USER_FEATURES: Record<string, boolean> = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

/** GraphQL operation IDs — extracted from the X web client JS bundle at runtime. */
const OPS: Record<string, string> = {};

/** Extract GraphQL operation hashes from the webpack chunk registry. */
const extractOps = (): void => {
  if (Object.keys(OPS).length > 0) return;
  try {
    const chunks = (globalThis as Record<string, unknown>).webpackChunk_twitter_responsive_web as
      | Array<[unknown, Record<string, (...args: never) => unknown>]>
      | undefined;
    if (!chunks) return;
    for (const chunk of chunks) {
      const modules = chunk[1];
      if (typeof modules !== 'object') continue;
      for (const mod of Object.values(modules)) {
        try {
          const src = mod.toString();
          const regex = /queryId\s*:\s*["']([^"']+)["']\s*,\s*operationName\s*:\s*["']([^"']+)["']/g;
          for (const m of src.matchAll(regex)) {
            const opName = m[2];
            const queryId = m[1];
            if (opName && queryId) OPS[opName] = queryId;
          }
        } catch {
          /* skip unparseable modules */
        }
      }
    }
  } catch {
    /* webpack not available */
  }
};

/** Get the operation hash for a named GraphQL operation. */
const getOpHash = (name: string): string => {
  extractOps();
  const hash = OPS[name];
  if (!hash) throw ToolError.internal(`GraphQL operation "${name}" not found in X client bundle`);
  return hash;
};

/** Get the CSRF token from the ct0 cookie. */
const getCsrfToken = (): string | null => {
  const match = document.cookie.match(/ct0=([^;]+)/);
  return match?.[1] ?? null;
};

/** Check if the user is authenticated on X. */
export const isAuthenticated = (): boolean => {
  const meta = (globalThis as Record<string, unknown>).__META_DATA__ as { isLoggedIn?: boolean } | undefined;
  if (meta?.isLoggedIn) return true;
  return getCsrfToken() !== null;
};

/** Wait up to 5 seconds for authentication to be available. */
export const waitForAuth = (): Promise<boolean> =>
  new Promise(resolve => {
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += 500;
      if (isAuthenticated()) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (elapsed >= 5000) {
        clearInterval(timer);
        resolve(false);
      }
    }, 500);
  });

/** Common request headers for all X API calls. */
const getHeaders = (): Record<string, string> => {
  const ct0 = getCsrfToken();
  if (!ct0) throw ToolError.auth('Not authenticated — please log in to X.');
  return {
    authorization: `Bearer ${BEARER_TOKEN}`,
    'x-csrf-token': ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
  };
};

/** Classify HTTP error responses into ToolError categories. */
const classifyError = async (response: Response, operation: string): Promise<never> => {
  const body = (await response.text().catch(() => '')).substring(0, 512);

  if (response.status === 429) {
    const retryAfter = response.headers.get('x-rate-limit-reset');
    const retryMs = retryAfter ? Number(retryAfter) * 1000 - Date.now() : parseRetryAfterMs('60');
    throw ToolError.rateLimited(`Rate limited: ${operation}`, retryMs);
  }
  if (response.status === 401 || response.status === 403) {
    throw ToolError.auth(`Auth error (${response.status}): ${body}`);
  }
  if (response.status === 404) {
    throw ToolError.notFound(`Not found: ${operation}`);
  }
  throw ToolError.internal(`API error (${response.status}): ${operation} — ${body}`);
};

/** Execute a GraphQL query (GET request). */
export const graphqlQuery = async <T>(
  operation: string,
  variables: Record<string, unknown>,
  options?: { features?: Record<string, boolean>; fieldToggles?: Record<string, boolean> },
): Promise<T> => {
  const hash = getOpHash(operation);
  const params = new URLSearchParams();
  params.set('variables', JSON.stringify(variables));
  params.set('features', JSON.stringify(options?.features ?? DEFAULT_FEATURES));
  if (options?.fieldToggles) {
    params.set('fieldToggles', JSON.stringify(options.fieldToggles));
  }

  let response: Response;
  try {
    response = await fetch(`${GRAPHQL_BASE}/${hash}/${operation}?${params.toString()}`, {
      headers: getHeaders(),
      credentials: 'include',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw ToolError.timeout(`Timed out: ${operation}`);
    }
    throw new ToolError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'network_error', {
      category: 'internal',
      retryable: true,
    });
  }

  if (!response.ok) return classifyError(response, operation);
  return (await response.json()) as T;
};

/** Execute a GraphQL mutation (POST request). */
export const graphqlMutation = async <T>(
  operation: string,
  variables: Record<string, unknown>,
  options?: { features?: Record<string, boolean> },
): Promise<T> => {
  const hash = getOpHash(operation);

  let response: Response;
  try {
    response = await fetch(`${GRAPHQL_BASE}/${hash}/${operation}`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        variables,
        features: options?.features ?? DEFAULT_FEATURES,
        queryId: hash,
      }),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw ToolError.timeout(`Timed out: ${operation}`);
    }
    throw new ToolError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'network_error', {
      category: 'internal',
      retryable: true,
    });
  }

  if (!response.ok) return classifyError(response, operation);
  return (await response.json()) as T;
};

/** Execute a REST API call (non-GraphQL). */
export const restApi = async <T>(
  endpoint: string,
  options?: { method?: string; query?: Record<string, string | undefined> },
): Promise<T> => {
  let url = `https://x.com/i/api${endpoint}`;
  if (options?.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined) params.append(k, v);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options?.method ?? 'GET',
      headers: getHeaders(),
      credentials: 'include',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw ToolError.timeout(`Timed out: ${endpoint}`);
    }
    throw new ToolError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'network_error', {
      category: 'internal',
      retryable: true,
    });
  }

  if (!response.ok) return classifyError(response, endpoint);
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};

export { DEFAULT_FEATURES, USER_FEATURES };
