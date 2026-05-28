import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, isOneNoteTab, isSharePointNotebook, waitForAuth } from './onenote-api.js';
import { createNotebook } from './tools/create-notebook.js';
import { createPage } from './tools/create-page.js';
import { createSection } from './tools/create-section.js';
import { createSectionGroup } from './tools/create-section-group.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { getNotebook } from './tools/get-notebook.js';
import { getRecentNotebooks } from './tools/get-recent-notebooks.js';
import { getSection } from './tools/get-section.js';
import { getSectionGroup } from './tools/get-section-group.js';
import { listNotebooks } from './tools/list-notebooks.js';
import { listSectionGroups } from './tools/list-section-groups.js';
import { listSections } from './tools/list-sections.js';
import { readCurrentPage } from './tools/read-current-page.js';

class OneNotePlugin extends OpenTabsPlugin {
  readonly name = 'onenote';
  readonly description = 'OpenTabs plugin for Microsoft OneNote';
  override readonly displayName = 'Microsoft OneNote';
  readonly urlPatterns = [
    '*://onenote.cloud.microsoft/*',
    '*://*.sharepoint.com/:o:/*',
    '*://*.sharepoint.com/personal/*/_layouts/*/Doc.aspx*',
    '*://*.sharepoint.com/sites/*/_layouts/*/Doc.aspx*',
  ];
  override readonly homepage = 'https://onenote.cloud.microsoft/';
  readonly tools: ToolDefinition[] = [
    // Notebooks
    listNotebooks,
    getNotebook,
    createNotebook,
    getRecentNotebooks,
    // Sections
    listSections,
    getSection,
    createSection,
    // Section Groups
    listSectionGroups,
    getSectionGroup,
    createSectionGroup,
    // Pages
    readCurrentPage,
    createPage,
    // Account
    getCurrentUser,
  ];

  async isReady(): Promise<boolean> {
    // The SharePoint Doc.aspx URL patterns are broad — only report ready on an actual OneNote page.
    if (!isOneNoteTab()) return false;
    if (isAuthenticated()) return true;
    // On SharePoint/OneDrive-hosted notebooks the Graph token has no Notes scope,
    // so isAuthenticated() is false there. Report the page as ready anyway so the
    // plugin activates: read_current_page works token-free, and the Graph-backed
    // tools throw a clear, informative error pointing to the standalone app.
    if (isSharePointNotebook()) return true;
    return waitForAuth();
  }
}

export default new OneNotePlugin();
