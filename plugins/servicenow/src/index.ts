import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ConfigSchema, ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './servicenow-api.js';
import { describeTable } from './tools/describe-table.js';
import { getChange } from './tools/get-change.js';
import { getConfigurationItem } from './tools/get-configuration-item.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { getIncident } from './tools/get-incident.js';
import { getIncidentStatus } from './tools/get-incident-status.js';
import { getKnowledgeArticle } from './tools/get-knowledge-article.js';
import { getProblem } from './tools/get-problem.js';
import { getRequestItem } from './tools/get-request-item.js';
import { getTaskByNumber } from './tools/get-task-by-number.js';
import { getUser } from './tools/get-user.js';
import { globalSearch } from './tools/global-search.js';
import { listFieldChoices } from './tools/list-field-choices.js';
import { listGroupMembers } from './tools/list-group-members.js';
import { listIncidentActivity } from './tools/list-incident-activity.js';
import { listIncidentAttachments } from './tools/list-incident-attachments.js';
import { listIncidentComments } from './tools/list-incident-comments.js';
import { listMyGroups } from './tools/list-my-groups.js';
import { listTaskSlas } from './tools/list-task-slas.js';
import { queryTable } from './tools/query-table.js';
import { searchChanges } from './tools/search-changes.js';
import { searchConfigurationItems } from './tools/search-configuration-items.js';
import { searchIncidents } from './tools/search-incidents.js';
import { searchKnowledge } from './tools/search-knowledge.js';
import { searchProblems } from './tools/search-problems.js';
import { searchRequestItems } from './tools/search-request-items.js';
import { searchRequests } from './tools/search-requests.js';
import { searchUsers } from './tools/search-users.js';
import { summarizeIncidents } from './tools/summarize-incidents.js';

class ServiceNowPlugin extends OpenTabsPlugin {
  readonly name = 'servicenow';
  readonly description = 'OpenTabs plugin for ServiceNow';
  override readonly displayName = 'ServiceNow';
  readonly urlPatterns = ['*://*.service-now.com/*'];
  override readonly configSchema: ConfigSchema = {
    instanceUrl: {
      type: 'url' as const,
      label: 'Instance URL',
      description:
        'The URL of your ServiceNow instance if it uses a custom domain (e.g., https://support.example.com). ' +
        'Leave empty for standard *.service-now.com instances.',
      required: false,
      placeholder: 'https://support.example.com',
    },
  };
  readonly tools: ToolDefinition[] = [
    // Incidents
    searchIncidents,
    getIncident,
    getIncidentStatus,
    listIncidentComments,
    listIncidentAttachments,
    listIncidentActivity,
    summarizeIncidents,
    // Changes
    searchChanges,
    getChange,
    // Problems
    searchProblems,
    getProblem,
    // Requests
    searchRequests,
    searchRequestItems,
    getRequestItem,
    // Tasks
    getTaskByNumber,
    listTaskSlas,
    // Knowledge
    searchKnowledge,
    getKnowledgeArticle,
    // Users
    getCurrentUser,
    searchUsers,
    getUser,
    listMyGroups,
    listGroupMembers,
    // Configuration items
    searchConfigurationItems,
    getConfigurationItem,
    // Platform
    globalSearch,
    describeTable,
    listFieldChoices,
    queryTable,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new ServiceNowPlugin();
