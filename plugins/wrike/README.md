# Wrike

OpenTabs plugin for Wrike — gives AI agents access to Wrike through your authenticated browser session.

## Install

```bash
opentabs plugin install wrike
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-wrike
```

## Setup

1. Open [www.wrike.com](https://www.wrike.com/workspace.htm) in Chrome and log in
2. Open the OpenTabs side panel — the Wrike plugin should appear as **ready**

## Tools (15)

### Account (2)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the logged-in user and account | Read |
| `list_contacts` | List or search account contacts | Read |

### Folders (2)

| Tool | Description | Type |
|---|---|---|
| `list_root_folders` | List top-level folders and spaces | Read |
| `list_folder_contents` | List tasks, folders, and projects in a folder | Read |

### Tasks (9)

| Tool | Description | Type |
|---|---|---|
| `get_task` | Get full details of a task | Read |
| `search_tasks` | Search tasks and projects by keyword | Read |
| `create_task` | Create a task in a folder or as a subtask | Write |
| `rename_task` | Change a task's title | Write |
| `delete_task` | Move a task to the Recycle Bin | Write |
| `list_task_statuses` | List a task workflow and its statuses | Read |
| `set_task_status` | Change a task's workflow status | Write |
| `assign_task` | Add or remove task assignees | Write |
| `set_task_dates` | Set a task's start and due dates | Write |

### Comments (2)

| Tool | Description | Type |
|---|---|---|
| `list_task_comments` | List comments and activity on a task | Read |
| `add_comment` | Post a comment on a task | Write |

## How It Works

This plugin runs inside your Wrike tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
