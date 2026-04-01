# Excel Online Plugin — Multi-Domain Support

## Status: Full Read + Write (All Domains)

The Excel Online plugin supports full read and write operations on workbooks hosted on both `excel.cloud.microsoft` and `*.sharepoint.com`. All 28 tools work identically across both domains.

## Domain Architecture

### excel.cloud.microsoft (Native)

On the native Excel Online domain, the plugin reads MSAL tokens directly from localStorage. Tokens are stored in plaintext `{secret, expires_on}` format. All Graph API workbook endpoints work natively.

### *.sharepoint.com (Token Bridge)

On SharePoint, MSAL tokens are encrypted and unreadable. The extension bridges a Graph API token from an open Outlook or Teams tab into the SharePoint tab. The Excel plugin consumes this bridged token for Graph API calls.

Write operations use the Microsoft Graph API workbook endpoints, which operate through the co-authoring protocol — no file lock conflicts, even when the file is open in the browser.

When no Outlook or Teams tab is open, read operations still work via the xlsx download-and-parse fallback (no token required). Write operations return an actionable error directing the user to open Outlook or Teams.

## Token Bridge Flow

```
Outlook/Teams Tab (*.cloud.microsoft)
  │
  ├── MSAL localStorage → access token (plaintext)
  ├── MSAL localStorage → refresh token (plaintext)
  │
  ▼
Chrome Extension (Background)
  │
  ├── readGraphTokenFromM365Tab() → reads access token
  ├── readRefreshTokenFromM365Tab() → reads refresh token
  ├── refreshAccessTokenViaOAuth() → exchanges refresh token for fresh access token
  │                                   POST login.microsoftonline.com/.../oauth2/v2.0/token
  ├── acquireGraphToken() → orchestrates: try access token, fallback to refresh grant
  │
  ▼
SharePoint Tab (*.sharepoint.com)
  │
  ├── globalThis.__openTabs.graphToken = { token, expiresOn }
  │
  ▼
Excel Plugin Adapter
  │
  ├── getBridgedGraphToken() → reads injected token
  ├── getAuth() → returns bridged token on SharePoint
  ├── api() → Graph API calls with Bearer token
  │
  └── All 28 tools work: reads, writes, formulas, tables, charts
```

### Token Refresh

1. Extension calls `acquireGraphToken()` during adapter injection (`bridgeGraphTokenIfNeeded`)
2. First tries reading a fresh access token from Outlook/Teams localStorage
3. If expired (or within 5-minute buffer), reads the MSAL refresh token from the same tab
4. Exchanges the refresh token via `POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` with `grant_type=refresh_token`
5. Fresh access token (~84 minute TTL) is injected into the SharePoint tab
6. On 401, the adapter posts `opentabs:request-token-refresh` → extension re-bridges via the same flow

## SharePoint Read-Only Fallback

When no Outlook or Teams tab is open, the plugin falls back to downloading and parsing the xlsx file in-browser. This bypasses authentication because it uses SharePoint's session cookies via the `_api/v2.1/` file download endpoint.

```
SharePoint Tab (*.sharepoint.com)
  │
  ├── _spPageContextInfo  → webAbsoluteUrl, userLoginName
  ├── _wopiContextJson    → DriveId, DriveItemId, FileName, FileId
  │
  ▼
Plugin Adapter (MAIN world)
  │
  ├── Read operations (xlsx fallback):
  │   1. Download xlsx via /_api/v2.1/drives/{driveId}/items/{itemId}/content
  │   2. Parse ZIP central directory → find xl/workbook.xml, xl/sharedStrings.xml, xl/worksheets/sheet*.xml
  │   3. Decompress entries via browser's DecompressionStream API
  │   4. Parse XML → extract sheet names, shared strings, cell values
  │   5. Cache parsed workbook for 30 seconds to avoid re-downloading
  │
  └── Write operations → return auth error directing user to open Outlook or Teams
```

## Tool Support Matrix (SharePoint)

| Tool | With Token | Without Token |
|------|-----------|--------------|
| `list_worksheets` | Graph API | xlsx parse |
| `get_range` | Graph API | xlsx parse |
| `get_used_range` | Graph API | xlsx parse |
| `get_workbook_info` | Graph API | WOPI context |
| `get_current_user` | Graph API | Page globals |
| `list_tables` | Graph API | Empty (no table XML parsing) |
| `get_table_rows` | Graph API | Error (needs token or use `get_range`) |
| `get_table_columns` | Graph API | Error (needs token) |
| `list_charts` | Graph API | Error (needs token) |
| `list_named_items` | Graph API | Error (needs token) |
| All write operations | Graph API | Auth error with guidance |

On `excel.cloud.microsoft`, all tools use the Graph API unconditionally.

## Limitations

1. **SharePoint writes require Outlook or Teams tab** — Write operations on SharePoint need a Graph API token bridged from an Outlook or Teams tab. Without one, writes return an auth error with guidance.

2. **30-second data staleness (xlsx fallback only)** — When using the xlsx parse fallback (no Graph token), the plugin caches the downloaded file for 30 seconds. With Graph API, reads return live data.

3. **No formula evaluation in xlsx fallback** — The xlsx parser reads stored cell values, not computed formula results.

4. **No table metadata in xlsx fallback** — Table definitions are not parsed from xlsx. The `list_tables` tool returns empty.

5. **Refresh token lifetime** — The MSAL refresh token is long-lived but not infinite. If the user's Outlook/Teams session expires (e.g., after logout), the bridge stops working until they re-authenticate.

## Approaches Investigated and Ruled Out

| Approach | Result |
|----------|--------|
| Read MSAL tokens from SharePoint localStorage | Encrypted `{id, nonce, data}`, unreadable |
| SharePoint Graph API proxy PUT (`/_api/v2.1/.../content`) | GET works with cookies, but PUT returns 403 "OAuth only flow" |
| SharePoint REST API PUT (`/_api/web/GetFileById/.../\$value`) | Auth works (session cookies + request digest), but returns 423 SPFileLockException — file is WOPI-locked while open in browser |
| SharePoint REST API file create (`Files/Add`) | Works (200) — but creates a new file, doesn't edit the open one |
| SharePoint token exchange (`SP.OAuth.Token/Acquire`) | Returns 400 "Resource is not allowed" for `graph.microsoft.com` |
| WOPI access token for Graph API | Wrong audience (SharePoint WOPI, not Graph) |
| WOPI PutFile protocol | Returns 500 InvalidProofSignature — requires crypto proof headers only the Office server can generate |
| MSAL `acquireTokenSilent()` on SharePoint page | No accessible PublicClientApplication instance |
| Excel Services REST API (`/_vti_bin/ExcelRest.aspx`) | Deprecated by Microsoft — returns "no longer supported" |
| `wacAadToken` page global | JWE (encrypted JWT), not decodable |
| Excel iframe internal APIs | Cross-origin — iframe loads from different origin than SharePoint host |
| **Graph API workbook endpoints with bridged token** | **Works — co-authoring protocol, no lock conflicts** |

## SharePoint Page Globals

Available on any SharePoint-hosted Excel file:

| Global | Field | Value |
|--------|-------|-------|
| `_wopiContextJson` | `DriveId` | Graph API drive identifier |
| `_wopiContextJson` | `DriveItemId` | Graph API item identifier |
| `_wopiContextJson` | `FileName` | Original filename |
| `_wopiContextJson` | `FileId` | SharePoint file GUID |
| `_wopiContextJson` | `DocUrl` | Full URL to the file |
| `_wopiContextJson` | `UserCanWrite` | Whether user has write permission |
| `_spPageContextInfo` | `webAbsoluteUrl` | Web site URL |
| `_spPageContextInfo` | `userLoginName` | Authenticated user's login |

## MSAL Token Formats by Domain

| Domain | Format | Plugin Can Read? |
|--------|--------|-----------------|
| `excel.cloud.microsoft` | Plaintext `{secret, expires_on}` | Yes |
| `outlook.cloud.microsoft` | Plaintext `{secret, expires_on}` | Yes |
| `teams.microsoft.com` | Plaintext `{secret, expires_on}` | Yes |
| `*.sharepoint.com` (MSAL v1) | Encrypted `{id, nonce, data}` | No |
| `*.sharepoint.com` (Identity.OAuth) | Plaintext JWT `{value: "eyJ..."}` | Readable but always expired/stale |
