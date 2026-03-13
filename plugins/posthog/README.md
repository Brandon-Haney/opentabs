# PostHog

OpenTabs plugin for PostHog — gives AI agents access to PostHog through your authenticated browser session.

## Install

```bash
opentabs plugin install posthog
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-posthog
```

## Setup

1. Open [us.posthog.com](https://us.posthog.com) in Chrome and log in
2. Open the OpenTabs side panel — the PostHog plugin should appear as **ready**

## Tools (32)

### Users (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get your PostHog profile | Read |

### Organization (1)

| Tool | Description | Type |
|---|---|---|
| `get_organization` | Get current organization info | Read |

### Projects (2)

| Tool | Description | Type |
|---|---|---|
| `list_projects` | List projects in the organization | Read |
| `get_project` | Get project details | Read |

### Dashboards (5)

| Tool | Description | Type |
|---|---|---|
| `list_dashboards` | List dashboards in the project | Read |
| `get_dashboard` | Get dashboard details | Read |
| `create_dashboard` | Create a new dashboard | Write |
| `update_dashboard` | Update a dashboard | Write |
| `delete_dashboard` | Delete a dashboard | Write |

### Insights (4)

| Tool | Description | Type |
|---|---|---|
| `list_insights` | List insights in the project | Read |
| `get_insight` | Get insight details | Read |
| `update_insight` | Update an insight | Write |
| `delete_insight` | Delete an insight | Write |

### Feature Flags (5)

| Tool | Description | Type |
|---|---|---|
| `list_feature_flags` | List feature flags | Read |
| `get_feature_flag` | Get feature flag details | Read |
| `create_feature_flag` | Create a new feature flag | Write |
| `update_feature_flag` | Update a feature flag | Write |
| `delete_feature_flag` | Delete a feature flag | Write |

### Experiments (3)

| Tool | Description | Type |
|---|---|---|
| `list_experiments` | List experiments | Read |
| `get_experiment` | Get experiment details | Read |
| `create_experiment` | Create a new experiment | Write |

### Annotations (3)

| Tool | Description | Type |
|---|---|---|
| `list_annotations` | List annotations | Read |
| `create_annotation` | Create a new annotation | Write |
| `delete_annotation` | Delete an annotation | Write |

### Persons (2)

| Tool | Description | Type |
|---|---|---|
| `list_persons` | List tracked persons | Read |
| `get_person` | Get person details | Read |

### Cohorts (2)

| Tool | Description | Type |
|---|---|---|
| `list_cohorts` | List cohorts | Read |
| `get_cohort` | Get cohort details | Read |

### Surveys (2)

| Tool | Description | Type |
|---|---|---|
| `list_surveys` | List surveys | Read |
| `get_survey` | Get survey details | Read |

### Actions (2)

| Tool | Description | Type |
|---|---|---|
| `list_actions` | List actions | Read |
| `get_action` | Get action details | Read |

## How It Works

This plugin runs inside your PostHog tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
