import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './wrike-api.js';

// Account & people
import { getCurrentUser } from './tools/get-current-user.js';
import { listContacts } from './tools/list-contacts.js';

// Folders & navigation
import { listRootFolders } from './tools/list-root-folders.js';
import { listFolderContents } from './tools/list-folder-contents.js';
import { createFolder } from './tools/create-folder.js';
import { createProject } from './tools/create-project.js';
import { listRecycleBin } from './tools/list-recycle-bin.js';
import { restoreFromRecycleBin } from './tools/restore-from-recycle-bin.js';

// Tasks
import { getTask } from './tools/get-task.js';
import { searchTasks } from './tools/search-tasks.js';
import { createTask } from './tools/create-task.js';
import { renameTask } from './tools/rename-task.js';
import { moveTask } from './tools/move-task.js';
import { deleteTask } from './tools/delete-task.js';
import { listTaskStatuses } from './tools/list-task-statuses.js';
import { setTaskStatus } from './tools/set-task-status.js';
import { assignTask } from './tools/assign-task.js';
import { setTaskDates } from './tools/set-task-dates.js';
import { listCustomFields } from './tools/list-custom-fields.js';
import { setCustomField } from './tools/set-custom-field.js';
import { listAttachments } from './tools/list-attachments.js';

// Comments
import { listTaskComments } from './tools/list-task-comments.js';
import { addComment } from './tools/add-comment.js';

class WrikePlugin extends OpenTabsPlugin {
  readonly name = 'wrike';
  readonly description = 'OpenTabs plugin for Wrike';
  override readonly displayName = 'Wrike';
  readonly urlPatterns = ['*://www.wrike.com/workspace.htm*'];
  override readonly homepage = 'https://www.wrike.com/workspace.htm';
  readonly tools: ToolDefinition[] = [
    // Account & people
    getCurrentUser,
    listContacts,

    // Folders & navigation
    listRootFolders,
    listFolderContents,
    createFolder,
    createProject,
    listRecycleBin,
    restoreFromRecycleBin,

    // Tasks
    getTask,
    searchTasks,
    createTask,
    renameTask,
    moveTask,
    deleteTask,
    listTaskStatuses,
    setTaskStatus,
    assignTask,
    setTaskDates,
    listCustomFields,
    setCustomField,
    listAttachments,

    // Comments
    listTaskComments,
    addComment,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new WrikePlugin();
