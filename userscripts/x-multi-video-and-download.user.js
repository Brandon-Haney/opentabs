// ==UserScript==
// @name         X — Multi-Video Playback + Media Downloader
// @namespace    https://x.com/
// @version      0.2.0
// @description  Lets multiple X (Twitter) videos play simultaneously across tabs, loops every video endlessly, and adds a download button next to every image and video in a post.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Feature 1: Multi-video playback (same page + across tabs)
  // ---------------------------------------------------------------------------
  //
  // X enforces "one video plays at a time" by calling .pause() on other videos
  // when a new one starts — both within a single page (player coordinator) and
  // across tabs (BroadcastChannel signal).
  //
  // Strategy: distinguish a *user-initiated* pause on video A from a
  // *coordinator-initiated* pause on video A. We track which player container
  // the user most recently interacted with; if pause() is called on a video
  // whose container is NOT the one the user just touched, it's the coordinator
  // and we drop it.
  //
  // The hidden-tab case falls out naturally: if no interaction has happened
  // in this tab, lastInteractedContainer is null, so any pause on a video
  // container is treated as coordinator and blocked.

  const containerOf = el => {
    if (!el || !el.closest) return null;
    return (
      el.closest('[data-testid="videoComponent"]') ||
      el.closest('[data-testid="videoPlayer"]') ||
      el.closest('article') ||
      null
    );
  };

  let lastInteractedContainer = null;
  let lastInteractionAt = 0;
  ['pointerdown', 'keydown'].forEach(evName => {
    document.addEventListener(
      evName,
      ev => {
        const c = containerOf(ev.target);
        if (c) {
          lastInteractedContainer = c;
          lastInteractionAt = Date.now();
        }
      },
      true,
    );
  });

  const origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function patchedPause() {
    // Cross-tab block: this tab is hidden, so any pause is almost certainly
    // a coordinator signal from another tab.
    if (document.visibilityState === 'hidden') return undefined;

    const myContainer = containerOf(this);
    // If we know which container the user just touched and it's NOT this
    // video's container, treat the pause as coordinator and drop it.
    // 5 second window keeps recent context; older interactions don't gate.
    if (
      myContainer &&
      lastInteractedContainer &&
      lastInteractedContainer !== myContainer &&
      Date.now() - lastInteractionAt < 5000
    ) {
      return undefined;
    }
    return origPause.apply(this, arguments);
  };

  // Defense in depth: drop messages on BroadcastChannels whose name hints at
  // video coordination. (Exact channel name isn't published; heuristic.)
  const origPostMessage = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function patchedPostMessage(msg) {
    if (typeof this.name === 'string' && /video|player|media|playback/i.test(this.name)) {
      return undefined;
    }
    return origPostMessage.call(this, msg);
  };

  // ---------------------------------------------------------------------------
  // Feature 2: Endless video looping
  // ---------------------------------------------------------------------------
  //
  // X loops only GIF-backed videos. Setting `loop` lets the browser restart
  // playback natively, so `ended` never fires and the player's end card never
  // appears. The player rewrites `loop` whenever it binds a source, so re-assert
  // it on the events that follow a bind, and keep an `ended` handler as a
  // fallback for the window in which the flag was cleared.

  const enforceLoop = videoEl => {
    if (videoEl.dataset.otXLoop === '1') return;
    videoEl.dataset.otXLoop = '1';
    videoEl.loop = true;
    ['loadedmetadata', 'play'].forEach(evName => {
      videoEl.addEventListener(evName, () => {
        videoEl.loop = true;
      });
    });
    videoEl.addEventListener('ended', () => {
      videoEl.loop = true;
      videoEl.currentTime = 0;
      const played = videoEl.play();
      if (played && typeof played.catch === 'function') played.catch(() => {});
    });
  };

  // ---------------------------------------------------------------------------
  // Feature 3: Download buttons for every image and video
  // ---------------------------------------------------------------------------

  const BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  // GraphQL operation hashes rotate with every X bundle release, so we
  // discover them dynamically. Three sources, in order of preference:
  //   1. Sniff from outgoing fetch/XHR traffic (works for anything the page
  //      has already loaded after this script was installed).
  //   2. Walk the webpack module registry and grep for `queryId`/`operationName`
  //      pairs (works the moment the page bundle has loaded, no traffic
  //      required — same approach as the OpenTabs X plugin).
  const opHashes = Object.create(null);

  const recordOpFromUrl = url => {
    if (typeof url !== 'string') return;
    const m = url.match(/\/i\/api\/graphql\/([^/]+)\/(\w+)/);
    if (m) opHashes[m[2]] = m[1];
  };

  const origFetch = window.fetch;
  window.fetch = function patchedFetch(input) {
    const url = typeof input === 'string' ? input : input?.url;
    recordOpFromUrl(url);
    return origFetch.apply(this, arguments);
  };

  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedXhrOpen(_method, url) {
    recordOpFromUrl(url);
    return origXhrOpen.apply(this, arguments);
  };

  let extractedFromWebpack = false;
  const extractOpsFromWebpack = () => {
    if (extractedFromWebpack) return;
    const chunks = window.webpackChunk_twitter_responsive_web;
    if (!Array.isArray(chunks)) return;
    const opRegex = /queryId\s*:\s*["']([^"']+)["']\s*,\s*operationName\s*:\s*["']([^"']+)["']/g;
    for (const chunk of chunks) {
      const modules = chunk?.[1];
      if (!modules || typeof modules !== 'object') continue;
      for (const mod of Object.values(modules)) {
        try {
          const src = mod.toString();
          for (const m of src.matchAll(opRegex)) {
            const queryId = m[1];
            const opName = m[2];
            if (opName && queryId) opHashes[opName] = queryId;
          }
        } catch {
          /* skip unparseable modules */
        }
      }
    }
    extractedFromWebpack = true;
  };

  const getCookie = name => {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  };

  // Minimal feature set required by TweetResultByRestId. Mirrors the values
  // sent by the X web client.
  const FEATURES = {
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

  const fetchTweetMedia = async tweetId => {
    let hash = opHashes.TweetResultByRestId;
    if (!hash) {
      extractOpsFromWebpack();
      hash = opHashes.TweetResultByRestId;
    }
    if (!hash) {
      throw new Error('Could not locate TweetResultByRestId hash in webpack chunks or page traffic.');
    }
    const ct0 = getCookie('ct0');
    if (!ct0) throw new Error('Not logged in to X.');

    const variables = {
      tweetId,
      withCommunity: false,
      includePromotedContent: false,
      withVoice: false,
    };
    const url =
      `https://x.com/i/api/graphql/${hash}/TweetResultByRestId` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

    const r = await origFetch(url, {
      headers: {
        authorization: `Bearer ${BEARER}`,
        'x-csrf-token': ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
      },
      credentials: 'include',
    });
    if (!r.ok) throw new Error(`X API ${r.status}`);
    const data = await r.json();
    let result = data?.data?.tweetResult?.result;
    if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet;
    return result?.legacy?.extended_entities?.media ?? [];
  };

  const pickBestMp4 = variants =>
    (variants || [])
      .filter(v => v.content_type === 'video/mp4' && v.url)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url ?? '';

  // Cross-origin downloads with the `download` attribute are unreliable; the
  // browser may navigate instead of saving. Fetch as a stream first so the
  // download originates from a same-origin blob: URL, and surface progress
  // to the caller along the way.
  const downloadUrl = async (url, filename, onProgress) => {
    try {
      const r = await origFetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const total = Number(r.headers.get('content-length')) || 0;
      const reader = r.body?.getReader();
      let blob;
      if (reader) {
        const chunks = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (onProgress) onProgress(total ? received / total : null, received, total);
        }
        blob = new Blob(chunks);
      } else {
        // Fallback for environments without streaming response bodies.
        blob = await r.blob();
      }
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    } catch (err) {
      console.warn('[x-downloader] blob download failed, opening in new tab', err);
      window.open(url, '_blank', 'noopener');
    }
  };

  const originalImageUrl = src => {
    try {
      const u = new URL(src);
      if (u.hostname === 'pbs.twimg.com') {
        u.searchParams.set('name', 'orig');
        return u.toString();
      }
    } catch {
      /* not a parseable URL — return as-is */
    }
    return src;
  };

  const tweetIdFromArticle = article => {
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const m = link.href.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  };

  const filenameFromUrl = (url, fallbackExt) => {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').pop() || '';
      if (/\.\w+$/.test(last)) return last;
      return `x-media-${Date.now()}.${fallbackExt}`;
    } catch {
      return `x-media-${Date.now()}.${fallbackExt}`;
    }
  };

  // -- Button styling -------------------------------------------------------
  const styleSheet = document.createElement('style');
  styleSheet.textContent = `
    .ot-x-dl-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 9999;
      width: 32px;
      height: 32px;
      border-radius: 9999px;
      background: rgba(15, 20, 25, 0.75);
      color: #fff;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      line-height: 1;
      backdrop-filter: blur(8px);
      transition: background-color 120ms ease, transform 120ms ease;
    }
    .ot-x-dl-btn:hover { background: rgba(29, 155, 240, 0.95); transform: scale(1.05); }
    .ot-x-dl-btn[disabled] { opacity: 0.85; cursor: progress; }
    .ot-x-dl-btn.ot-x-dl-done,
    .ot-x-dl-btn.ot-x-dl-done:hover {
      background: rgba(0, 186, 124, 0.95);
      transform: none;
    }
    .ot-x-dl-btn .ot-x-dl-pct {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: -0.5px;
      font-feature-settings: 'tnum';
    }
    .ot-x-dl-host { position: relative; }
  `;
  (document.head || document.documentElement).appendChild(styleSheet);

  const SVG_DOWNLOAD =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 3a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42L11 14.59V4a1 1 0 0 1 1-1zm-7 16h14a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2z"/>' +
    '</svg>';

  const SVG_CHECK =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M20.7 5.8a1 1 0 0 1 0 1.4l-10 10a1 1 0 0 1-1.4 0l-4.5-4.5a1 1 0 1 1 1.4-1.4l3.8 3.79 9.3-9.3a1 1 0 0 1 1.4 0z"/>' +
    '</svg>';

  // How long the checkmark stays up after a successful save.
  const DONE_BADGE_MS = 2000;

  const ensureRelativeHost = el => {
    const cs = getComputedStyle(el);
    if (cs.position === 'static') el.style.position = 'relative';
  };

  const attachButton = (host, onClick, title) => {
    if (host.querySelector(':scope > .ot-x-dl-btn')) return;
    ensureRelativeHost(host);
    const btn = document.createElement('button');
    btn.className = 'ot-x-dl-btn';
    btn.type = 'button';
    btn.title = title;
    btn.innerHTML = SVG_DOWNLOAD;
    const setProgress = pct => {
      if (pct == null) {
        btn.innerHTML = SVG_DOWNLOAD;
      } else {
        const display = Math.max(0, Math.min(99, Math.floor(pct * 100)));
        btn.innerHTML = `<span class="ot-x-dl-pct">${display}%</span>`;
      }
    };
    let doneTimer = null;
    const clearDone = () => {
      if (doneTimer !== null) clearTimeout(doneTimer);
      doneTimer = null;
      btn.classList.remove('ot-x-dl-done');
      btn.title = title;
    };
    const showDone = () => {
      btn.classList.add('ot-x-dl-done');
      btn.innerHTML = SVG_CHECK;
      btn.title = 'Saved';
      doneTimer = setTimeout(() => {
        clearDone();
        setProgress(null);
      }, DONE_BADGE_MS);
    };
    btn.addEventListener('click', async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      clearDone();
      btn.disabled = true;
      setProgress(0);
      try {
        await onClick(setProgress);
        btn.disabled = false;
        showDone();
      } catch (err) {
        console.warn('[x-downloader]', err);
        btn.disabled = false;
        setProgress(null);
        alert(`Download failed: ${err.message || err}`);
      }
    });
    host.appendChild(btn);
  };

  // -- Decorate images ------------------------------------------------------
  const decorateImage = img => {
    const src = img.currentSrc || img.src;
    if (!src.includes('pbs.twimg.com/media/')) return;
    // Find the closest positioned ancestor that contains just this image,
    // so the button overlays the image rather than the whole tweet.
    const host = img.closest('[data-testid="tweetPhoto"]') || img.parentElement;
    if (!host || host.dataset.otXDl === '1') return;
    host.dataset.otXDl = '1';
    attachButton(
      host,
      onProgress => {
        const orig = originalImageUrl(src);
        return downloadUrl(orig, filenameFromUrl(orig, 'jpg'), onProgress);
      },
      'Download original image',
    );
  };

  // -- Decorate videos ------------------------------------------------------
  const decorateVideo = videoEl => {
    const article = videoEl.closest('article');
    if (!article) return;
    const host =
      videoEl.closest('[data-testid="videoPlayer"]') ||
      videoEl.closest('[data-testid="videoComponent"]') ||
      videoEl.parentElement;
    if (!host || host.dataset.otXDl === '1') return;
    host.dataset.otXDl = '1';
    attachButton(
      host,
      async onProgress => {
        const tweetId = tweetIdFromArticle(article);
        if (!tweetId) throw new Error('Could not find tweet ID');
        const media = await fetchTweetMedia(tweetId);
        const playable = media.filter(m => m.type === 'video' || m.type === 'animated_gif');
        if (playable.length === 0) throw new Error('No downloadable video variant (DRM-protected?)');
        // If multiple videos in one tweet, download all sequentially with jitter.
        for (let i = 0; i < playable.length; i++) {
          const url = pickBestMp4(playable[i].video_info?.variants);
          if (!url) continue;
          await downloadUrl(url, filenameFromUrl(url, 'mp4'), onProgress);
          if (i < playable.length - 1) {
            // Jittered 400-1200ms gap to look like normal browsing rather than a burst.
            await new Promise(res => setTimeout(res, 400 + Math.random() * 800));
          }
        }
      },
      'Download video',
    );
  };

  // -- Scan + observe -------------------------------------------------------
  // A mutation can add the media element itself rather than a wrapper, so match
  // the root alongside its descendants.
  const forEachMatch = (root, selector, fn) => {
    if (root.matches?.(selector)) fn(root);
    root.querySelectorAll?.(selector).forEach(fn);
  };

  const scan = root => {
    const scope = root ?? document;
    forEachMatch(scope, 'img[src*="pbs.twimg.com/media/"]', decorateImage);
    forEachMatch(scope, 'video', videoEl => {
      enforceLoop(videoEl);
      decorateVideo(videoEl);
    });
  };

  const observer = new MutationObserver(mutations => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  });

  const start = () => {
    scan(document);
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
