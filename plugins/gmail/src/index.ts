import { isAuthenticated, waitForAuth } from './gmail-api.js';
import { archiveEmail } from './tools/archive-email.js';
import { getProfile } from './tools/get-profile.js';
import { listEmails } from './tools/list-emails.js';
import { listLabels } from './tools/list-labels.js';
import { markAsRead } from './tools/mark-read.js';
import { markAsUnread } from './tools/mark-unread.js';
import { navigateTo } from './tools/navigate-to.js';
import { readEmail } from './tools/read-email.js';
import { searchEmails } from './tools/search-emails.js';
import { starEmail } from './tools/star-email.js';
import { trashEmail } from './tools/trash-email.js';
import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';

class GmailPlugin extends OpenTabsPlugin {
  readonly name = 'gmail';
  readonly description = 'OpenTabs plugin for Gmail';
  override readonly displayName = 'Gmail';
  readonly urlPatterns = ['*://mail.google.com/*'];
  readonly tools: ToolDefinition[] = [
    listEmails,
    readEmail,
    searchEmails,
    navigateTo,
    listLabels,
    getProfile,
    archiveEmail,
    trashEmail,
    starEmail,
    markAsRead,
    markAsUnread,
  ];

  async isReady(): Promise<boolean> {
    // Primary check: GLOBALS array with user email
    if (isAuthenticated()) return true;
    // SPA hydration: poll for auth
    return waitForAuth();
  }
}

export default new GmailPlugin();
