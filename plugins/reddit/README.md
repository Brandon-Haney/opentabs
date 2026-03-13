# Reddit

OpenTabs plugin for Reddit — gives AI agents access to Reddit through your authenticated browser session.

## Install

```bash
opentabs plugin install reddit
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-reddit
```

## Setup

1. Open [www.reddit.com](https://www.reddit.com) in Chrome and log in
2. Open the OpenTabs side panel — the Reddit plugin should appear as **ready**

## Tools (15)

### User (2)

| Tool | Description | Type |
|---|---|---|
| `get_me` | Get the current user profile | Read |
| `get_user` | Get a user profile | Read |

### Posts (4)

| Tool | Description | Type |
|---|---|---|
| `list_posts` | List posts from a subreddit | Read |
| `get_post` | Get a post and its comments | Read |
| `search_posts` | Search Reddit posts | Read |
| `submit_post` | Submit a new post | Write |

### Comments (1)

| Tool | Description | Type |
|---|---|---|
| `submit_comment` | Post a comment or reply | Write |

### Actions (2)

| Tool | Description | Type |
|---|---|---|
| `vote` | Vote on a post or comment | Write |
| `save` | Save or unsave a post/comment | Write |

### Subreddits (4)

| Tool | Description | Type |
|---|---|---|
| `get_subreddit` | Get subreddit details | Read |
| `search_subreddits` | Search subreddits | Read |
| `list_subscriptions` | List subscribed subreddits | Read |
| `subscribe` | Subscribe or unsubscribe from a subreddit | Write |

### Messages (2)

| Tool | Description | Type |
|---|---|---|
| `send_message` | Send a private message | Write |
| `read_inbox` | Read inbox messages | Read |

## How It Works

This plugin runs inside your Reddit tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
