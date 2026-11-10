# ServiceNow

OpenTabs plugin for ServiceNow — gives AI agents access to ServiceNow through your authenticated browser session.

## Install

```bash
opentabs plugin install servicenow
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-servicenow
```

## Setup

1. Open [service-now.com](https://service-now.com) in Chrome and log in
2. Open the OpenTabs side panel — the ServiceNow plugin should appear as **ready**

## Configuration

Configure settings via `opentabs plugin configure servicenow` or the side panel.

| Setting | Type | Required | Description |
|---|---|---|---|
| `instanceUrl` | url | No | The URL of your ServiceNow instance if it uses a custom domain (e.g., https://support.example.com). Leave empty for standard *.service-now.com instances. |

## Tools (32)

### Incidents (8)

| Tool | Description | Type |
|---|---|---|
| `search_incidents` | Search incidents by text, state, priority, or assignee | Read |
| `get_incident` | Read one incident in full by number or sys_id | Read |
| `get_incident_status` | Check the state of up to 50 incidents in one call | Read |
| `list_incident_comments` | Read the comments and work notes on one incident | Read |
| `list_incident_attachments` | Files attached to an incident, newest first | Read |
| `get_attachment` | Save an attachment to a path | Read |
| `list_incident_activity` | Read the field-change and email history of an incident | Read |
| `summarize_incidents` | Count incidents grouped by state, priority, group, or assignee | Write |

### Comments (2)

| Tool | Description | Type |
|---|---|---|
| `preview_comment` | Check a comment before posting it, without writing | Read |
| `add_comment` | Post a comment or work note on a record | Write |

### Changes (2)

| Tool | Description | Type |
|---|---|---|
| `search_changes` | Search change requests by text, state, type, or assignee | Read |
| `get_change` | Read one change request by number or sys_id | Read |

### Problems (2)

| Tool | Description | Type |
|---|---|---|
| `search_problems` | Search problem records by text, state, or known-error flag | Read |
| `get_problem` | Read one problem record by number or sys_id | Read |

### Requests (3)

| Tool | Description | Type |
|---|---|---|
| `search_requests` | Search catalog requests (REQ) raised for a user | Read |
| `search_request_items` | Search requested items (RITM) by text, state, or queue | Read |
| `get_request_item` | Get one requested item (RITM) by number or sys_id | Read |

### Tasks (2)

| Tool | Description | Type |
|---|---|---|
| `get_task_by_number` | Resolve any task number to its record and table | Read |
| `list_task_slas` | SLA tracking for a task, with a breach count | Read |

### Knowledge (2)

| Tool | Description | Type |
|---|---|---|
| `search_knowledge` | Search knowledge articles by number, title, or body | Read |
| `get_knowledge_article` | Read a knowledge article by number or sys_id | Read |

### Users (5)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Signed-in user and the groups they belong to | Read |
| `search_users` | Find users by name, login name, or email | Read |
| `get_user` | Read one user by sys_id, login name, or email | Read |
| `list_my_groups` | Groups the signed-in user belongs to | Read |
| `list_group_members` | List the users belonging to a group | Read |

### Configuration Items (2)

| Tool | Description | Type |
|---|---|---|
| `search_configuration_items` | Search the CMDB by name, serial number, class, or owner | Read |
| `get_configuration_item` | Fetch one CMDB item by sys_id or exact name | Read |

### Platform (4)

| Tool | Description | Type |
|---|---|---|
| `global_search` | Full-text search across several ServiceNow tables | Write |
| `describe_table` | List the columns of a table | Write |
| `list_field_choices` | List the allowed values of a choice field | Read |
| `query_table` | Run a raw encoded query against any table | Read |

## How It Works

This plugin runs inside your ServiceNow tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT

## Notes

### Writing to records

`add_comment` is the only tool that changes anything. Every other tool reads. It adds one journal
entry and has no way to create, close, reassign, or edit a record.

An entry cannot be edited or deleted afterwards, and a customer-visible comment usually emails the
requester, so posting is built around checking first:

- `preview_comment` shows the record, the requester, the latest entries, whether your account may
  write that field on that record, and the exact request a post would send. It issues only reads.
- `add_comment` needs an explicit choice between `comments` (shared with the requester) and
  `work_notes` (internal). There is no default.
- Identical text from you on the same field is refused, so a repeated call cannot post twice.
- After posting, the tool reads the record back and reports `status`. ServiceNow answers success
  even when an access rule made it skip the field, so `not_in_journal` means the success response
  did not produce an entry. Check the record before trying again.

Set `add_comment` to **Ask** in the side panel so each post waits for your approval. A plugin's
permission applies to all of its tools, including this one, unless you override it per tool.

### Signing in

The plugin uses your existing browser session. Open your ServiceNow instance in a tab and sign in;
no API key or OAuth setup is required. If the tab has been open for a long time the instance may
have rotated its session token — the plugin detects this and recovers on its own, so you should
never need to reload the page.

### Instance-specific fields

Most ServiceNow deployments add their own columns on top of the stock ones, conventionally prefixed
`u_`. `get_incident` returns those in a `custom_fields` map alongside the standard fields, so
deployment-specific detail — site, asset, contact, or billing information — comes back without the
plugin needing to know your schema in advance. Use `describe_table` to see what your instance has
added.

### Knowledge article versions

ServiceNow keeps every past revision of a knowledge article as its own record under the same
article number. `get_knowledge_article` returns the current revision, and `search_knowledge`
returns one result per article rather than one per revision; pass `include_superseded` to see the
older ones.

### Custom domains

Instances on `*.service-now.com` work out of the box. If your instance is served from a custom
domain, set the Instance URL in the plugin's settings so the extension recognises those tabs:

```bash
opentabs config set setting.servicenow.instanceUrl https://support.example.com
```

### Large instances

Production instances routinely hold millions of records. Searches default to the queues you belong
to rather than the whole instance, and `summarize_incidents` answers "how many" questions by asking
the instance to aggregate rather than by paging through records. Widen a search with `scope: "all"`
only for a targeted lookup.
