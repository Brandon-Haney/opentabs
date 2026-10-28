# Jira

OpenTabs plugin for Jira — gives AI agents access to Jira through your authenticated browser session.

## Install

```bash
opentabs plugin install jira
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-jira
```

## Setup

1. Open [atlassian.net](https://atlassian.net) in Chrome and log in
2. Open the OpenTabs side panel — the Jira plugin should appear as **ready**

## Tools (21)

### Issues (12)

| Tool | Description | Type |
|---|---|---|
| `search_issues` | Search issues using JQL | Read |
| `get_issue` | Get details of an issue | Read |
| `create_issue` | Create a new Jira issue | Write |
| `update_issue` | Update an existing issue | Write |
| `delete_issue` | Delete an issue | Write |
| `transition_issue` | Change an issue's status | Write |
| `get_transitions` | Get available status transitions | Read |
| `assign_issue` | Assign or unassign an issue | Write |
| `link_issues` | Link two issues together | Write |
| `add_watcher` | Add a watcher to an issue | Write |
| `list_issue_types` | List available issue types | Read |
| `list_priorities` | List available priorities | Read |

### Comments (2)

| Tool | Description | Type |
|---|---|---|
| `add_comment` | Add a comment to an issue, with images and threaded replies | Write |
| `list_comments` | List comments on an issue | Read |

### Attachments (1)

| Tool | Description | Type |
|---|---|---|
| `add_attachment` | Attach files to an issue | Write |

### Projects (2)

| Tool | Description | Type |
|---|---|---|
| `list_projects` | List accessible projects | Read |
| `get_project` | Get details of a project | Read |

### Boards (2)

| Tool | Description | Type |
|---|---|---|
| `list_boards` | List agile boards | Read |
| `list_sprints` | List sprints for a board | Read |

### Users (2)

| Tool | Description | Type |
|---|---|---|
| `search_users` | Search for users by name or email | Read |
| `get_myself` | Get the current user's profile | Read |

## How It Works

This plugin runs inside your Jira tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
