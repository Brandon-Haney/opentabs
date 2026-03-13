# Azure Portal

OpenTabs plugin for Microsoft Azure Portal — gives AI agents access to Azure Portal through your authenticated browser session.

## Install

```bash
opentabs plugin install azure
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-azure
```

## Setup

1. Open [portal.azure.com](https://portal.azure.com) in Chrome and log in
2. Open the OpenTabs side panel — the Azure Portal plugin should appear as **ready**

## Tools (26)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current user profile | Read |

### Tenants (1)

| Tool | Description | Type |
|---|---|---|
| `list_tenants` | List all Azure AD tenants | Read |

### Subscriptions (2)

| Tool | Description | Type |
|---|---|---|
| `list_subscriptions` | List all Azure subscriptions | Read |
| `get_subscription` | Get subscription details | Read |

### Resource Groups (4)

| Tool | Description | Type |
|---|---|---|
| `list_resource_groups` | List resource groups in a subscription | Read |
| `get_resource_group` | Get resource group details | Read |
| `create_resource_group` | Create a resource group | Write |
| `delete_resource_group` | Delete a resource group | Write |

### Resources (4)

| Tool | Description | Type |
|---|---|---|
| `list_resources` | List Azure resources | Read |
| `get_resource` | Get a resource by ID | Read |
| `delete_resource` | Delete a resource by ID | Write |
| `list_resource_providers` | List resource providers in a subscription | Read |

### Deployments (4)

| Tool | Description | Type |
|---|---|---|
| `list_deployments` | List deployments in a resource group | Read |
| `get_deployment` | Get deployment details | Read |
| `create_deployment` | Create a template deployment | Write |
| `delete_deployment` | Delete a deployment | Write |

### Activity Log (1)

| Tool | Description | Type |
|---|---|---|
| `list_activity_logs` | Query activity log events | Read |

### Locations (2)

| Tool | Description | Type |
|---|---|---|
| `list_locations` | List all Azure regions | Read |
| `list_subscription_locations` | List available locations for a subscription | Read |

### Tags (1)

| Tool | Description | Type |
|---|---|---|
| `list_tags` | List all tags in a subscription | Read |

### Locks (3)

| Tool | Description | Type |
|---|---|---|
| `list_locks` | List management locks | Read |
| `create_lock` | Create a management lock | Write |
| `delete_lock` | Delete a management lock | Write |

### Policy (2)

| Tool | Description | Type |
|---|---|---|
| `list_policy_assignments` | List policy assignments | Read |
| `get_policy_assignment` | Get policy assignment details | Read |

### Role Assignments (1)

| Tool | Description | Type |
|---|---|---|
| `list_role_assignments` | List RBAC role assignments | Read |

## How It Works

This plugin runs inside your Azure Portal tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
