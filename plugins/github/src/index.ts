import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './github-api.js';
import { addReaction } from './tools/add-reaction.js';
import { createComment } from './tools/create-comment.js';
import { createIssue } from './tools/create-issue.js';
import { createOrUpdateFile } from './tools/create-or-update-file.js';
import { createPullRequest } from './tools/create-pull-request.js';
import { createRepo } from './tools/create-repo.js';
import { getFileContent } from './tools/get-file-content.js';
import { getIssue } from './tools/get-issue.js';
import { getPullRequest } from './tools/get-pull-request.js';
import { getRepo } from './tools/get-repo.js';
import { getUserProfile } from './tools/get-user-profile.js';
import { listBranches } from './tools/list-branches.js';
import { listComments } from './tools/list-comments.js';
import { listIssues } from './tools/list-issues.js';
import { listNotifications } from './tools/list-notifications.js';
import { listOrgMembers } from './tools/list-org-members.js';
import { listPullRequests } from './tools/list-pull-requests.js';
import { listRepos } from './tools/list-repos.js';
import { mergePullRequest } from './tools/merge-pull-request.js';
import { searchIssues } from './tools/search-issues.js';
import { updateIssue } from './tools/update-issue.js';

class GitHubPlugin extends OpenTabsPlugin {
  readonly name = 'github';
  readonly description = 'OpenTabs plugin for GitHub';
  override readonly displayName = 'GitHub';
  readonly urlPatterns = ['*://github.com/*'];
  readonly tools: ToolDefinition[] = [
    // Repositories
    listRepos,
    getRepo,
    createRepo,
    // Issues
    listIssues,
    getIssue,
    createIssue,
    updateIssue,
    searchIssues,
    // Pull Requests
    listPullRequests,
    getPullRequest,
    createPullRequest,
    mergePullRequest,
    // Comments
    listComments,
    createComment,
    // Users & Orgs
    getUserProfile,
    listOrgMembers,
    // Branches
    listBranches,
    // Content
    getFileContent,
    createOrUpdateFile,
    // Interactions
    addReaction,
    listNotifications,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new GitHubPlugin();
