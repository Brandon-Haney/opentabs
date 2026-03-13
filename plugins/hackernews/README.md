# Hacker News

OpenTabs plugin for Hacker News — gives AI agents access to Hacker News through your authenticated browser session.

## Install

```bash
opentabs plugin install hackernews
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-hackernews
```

## Setup

1. Open [news.ycombinator.com](https://news.ycombinator.com) in Chrome and log in
2. Open the OpenTabs side panel — the Hacker News plugin should appear as **ready**

## Tools (9)

### Items (2)

| Tool | Description | Type |
|---|---|---|
| `get_item` | Get a story, comment, or job by ID | Read |
| `get_story_comments` | Get comments for a story | Read |

### Users (1)

| Tool | Description | Type |
|---|---|---|
| `get_user` | Get a user profile by username | Read |

### Stories (6)

| Tool | Description | Type |
|---|---|---|
| `list_top_stories` | Get current front page stories | Read |
| `list_new_stories` | Get newest stories | Read |
| `list_best_stories` | Get best stories | Read |
| `list_ask_stories` | Get Ask HN stories | Read |
| `list_show_stories` | Get Show HN stories | Read |
| `list_job_stories` | Get job postings | Read |

## How It Works

This plugin runs inside your Hacker News tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
