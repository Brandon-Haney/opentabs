# Install the Extension

## From Chrome Web Store

_(Coming soon)_

## From Source (Developer Mode)

1. Clone the repository:

```bash
git clone https://github.com/opentabs-dev/opentabs.git
cd opentabs
```

2. Install dependencies and build:

```bash
bun install
bun run build
```

3. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked**
   - Select the `platform/browser-extension/dist` folder

4. The OpenTabs icon appears in your toolbar. Click it to open the side panel.

## Verify Installation

The extension's side panel shows connection status. It will display "Disconnected" until you start the MCP server.
