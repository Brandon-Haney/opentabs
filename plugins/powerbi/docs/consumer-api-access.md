# Power BI REST access for an app-consumer account

Verified live 2026-08-06 against a real tenant. The account under test was a
**content consumer**: it receives reports through published apps and holds
`Build` on the underlying semantic models, but has **no workspace membership**.
That is the common shape for a business user, and it is far more restrictive
than the docs imply — most published examples assume workspace access and simply
do not work here.

Nothing in this file is tenant-specific; it records which routes answer and which
refuse for that permission shape.

## Auth

`window.powerBIAccessToken` on an `app.powerbi.com` tab is a live token with
audience `https://analysis.windows.net/powerbi/api` and scope
`user_impersonation`, TTL roughly an hour.

The fallback is MSAL's cache in **`sessionStorage`**, not `localStorage` — Power
BI configures MSAL for session storage, so a helper that only scans
`localStorage` finds nothing and looks like an auth failure.

**A Microsoft Graph token is a different audience and is rejected here.** Do not
reuse one from another Microsoft plugin.

CORS is not a blocker: `api.powerbi.com` answers the `Authorization`-header
preflight from the `app.powerbi.com` origin, so requests can be made directly
from the page with `credentials: 'omit'`. No background-worker proxy is needed.

## What answers, and what refuses

| Endpoint | Result |
| --- | --- |
| `GET /groups` | **200 but empty** — no workspace membership |
| `GET /groups/{id}/**` (anything) | **401** |
| `GET /datasets/{id}` | **404** — the non-group form resolves My Workspace only |
| `POST /datasets/{id}/executeQueries` | **200** — works on `Build` alone |
| `POST /groups/{ws}/datasets/{id}/executeQueries` | 401 |
| `GET /reports` | 200 — carries **`datasetId` and `datasetWorkspaceId`** |
| `GET /reports/{id}/pages` | 200 |
| `GET /apps`, `GET /apps/{id}` | 200 — the latter exposes `workspaceId` |
| `GET /apps/{appId}/reports` | 200, but `datasetId` is **null** for consumers |
| `GET /apps/{appId}/reports/{rid}/pages` | 404 — the endpoint does not exist |

**Build everything on the non-group forms.** The empty `/groups` is the trap: it
returns 200 with an empty list rather than an error, so a discovery flow written
around workspaces reports "no content" instead of "wrong route".

`GET /reports` is the discovery backbone — it is the only route that yields the
dataset-to-workspace mapping. Note that an **app report id and its underlying
report id are different GUIDs**, and only the one from `/reports` works with
`/pages`.

## Model introspection

`INFO.TABLES()` and `INFO.MEASURES()` fail with Analysis Services error
`3239575670` (elevated permission required). The **`INFO.VIEW.*` family works on
`Build` alone** — `INFO.VIEW.TABLES()`, `INFO.VIEW.MEASURES()`,
`INFO.VIEW.COLUMNS()`.

Wrap them in `SELECTCOLUMNS` to bound the payload and to drop `[Expression]`,
which otherwise returns full DAX bodies for every measure.

`INFO.VIEW.MEASURES()` returns null for `[Expression]` and `[Description]` at
this permission level, so **the API publishes no explanation of what a measure
means**. Where two similarly-named measures exist, that has to be resolved with
the user rather than guessed.

## executeQueries quirks

- **No column list is returned.** Derive columns from the union of keys across
  all rows.
- **Always send `serializerSettings.includeNulls: true`.** Without it a null cell
  omits its key entirely, so rows have inconsistent shapes and a positional
  reader silently misaligns.
- **Errors arrive inside an HTTP 200** — check both `response.error` and the
  per-entry `results[i].error`.

## Crossing over from Excel

An Excel workbook connection string encodes the model id:
`Initial Catalog=sobe_wowvirtualserver-<GUID>`, where `<GUID>` **is** the
`datasetId`. That is how a workbook's PivotTable is tied back to the semantic
model it draws on without any workspace access.
