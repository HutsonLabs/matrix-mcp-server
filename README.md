# Matrix MCP Server

Give Claude Code (or Claude Desktop) the ability to send and receive messages over [Matrix](https://matrix.org) — an open, self-hosted, end-to-end encrypted messaging protocol.

Messages from Matrix push directly into your Claude Code session via the **Channels** feature. Claude can reply, read history, create rooms, and manage your server — all through MCP tools.

## What you get

- **Two-way messaging** — Claude receives Matrix messages in real-time and can reply
- **9 MCP tools** — send messages, read history, create rooms, invite users, typing indicators, and more
- **E2EE support** — transparent encryption via the Rust SDK crypto provider
- **Channel integration** — incoming messages push into Claude Code sessions (no polling)
- **Self-hosted** — runs on your own Matrix homeserver, nothing leaves your network

## Quick start

If you already have a Matrix homeserver, skip to [Configure Claude Code](#3-configure-claude-code).

### 1. Set up a Matrix homeserver

The `matrix-server/` directory contains a Docker Compose stack that runs Synapse (the Matrix homeserver), Element (web client), and PostgreSQL.

**Prerequisites:** Docker or Podman with Compose.

```bash
cd matrix-server

# Copy and edit the config templates
cp .env.example .env
cp synapse-data/homeserver.yaml.example synapse-data/homeserver.yaml
cp element/config.json.example element/config.json
```

Edit each file and replace the placeholder values:

- `.env` — set a real `POSTGRES_PASSWORD`
- `synapse-data/homeserver.yaml` — replace `YOUR_DOMAIN` with your domain, generate secrets (instructions in the file), set the database password to match
- `element/config.json` — replace `YOUR_DOMAIN`

Generate the signing key and start:

```bash
docker compose run --rm synapse generate
docker compose up -d
```

**Set up a reverse proxy** to route HTTPS traffic to Synapse (port 8008) and optionally Element (port 8009). Caddy example:

```
chat.yourdomain.com {
    reverse_proxy localhost:8008 {
        header_up X-Forwarded-Proto https
    }
}
```

### 2. Create accounts

```bash
# Create your admin account
docker compose exec synapse register_new_matrix_user \
  -c /data/homeserver.yaml --no-ssl \
  -u your_username -p your_password -a \
  http://localhost:8008

# Create a bot account for Claude
docker compose exec synapse register_new_matrix_user \
  -c /data/homeserver.yaml --no-ssl \
  -u claude-bot -p bot_password \
  http://localhost:8008
```

After creating accounts, disable registration in `homeserver.yaml`:

```yaml
enable_registration: false
```

Then restart: `docker compose restart synapse`

Get the bot's access token:

```bash
curl -s -X POST https://YOUR_DOMAIN/_matrix/client/v3/login \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","user":"claude-bot","password":"bot_password"}' \
  | jq -r '.access_token'
```

### 3. Configure Claude Code

Install dependencies and build:

```bash
cd /path/to/matrix-mcp-server
npm install
npm run build
```

Register the MCP server with Claude Code using the CLI:

```bash
claude mcp add-json -s user matrix '{
  "command": "node",
  "args": ["/absolute/path/to/matrix-mcp-server/dist/index.js"],
  "env": {
    "MATRIX_HOMESERVER": "https://YOUR_DOMAIN",
    "MATRIX_ACCESS_TOKEN": "YOUR_BOT_ACCESS_TOKEN",
    "MATRIX_USER_ID": "@claude-bot:YOUR_DOMAIN"
  }
}'
```

Replace the placeholder values with your actual homeserver URL, bot access token, and bot user ID. The path in `args` **must be absolute**.

Optional: restrict which Matrix users can push messages into Claude by adding to the `env` object:

```json
"MATRIX_ALLOWED_USERS": "@your_username:YOUR_DOMAIN"
```

Verify the server is connected:

```bash
claude mcp get matrix
```

You should see:

```
matrix:
  Scope: User config (available in all your projects)
  Status: ✓ Connected
```

#### Configuration scopes

The `-s` flag controls where the server is registered:

| Scope | Flag | Availability |
|-------|------|-------------|
| `user` | `-s user` | All Claude Code sessions (recommended) |
| `local` | `-s local` (default) | Only the current directory, not committed to git |
| `project` | `-s project` | Current project, committed to git via `.mcp.json` |

This repo includes a `.mcp.json.example` file as a reference for project-scoped configuration. To use it:

```bash
cp .mcp.json.example .mcp.json
# Edit .mcp.json with your values
```

Project-scoped configs are useful for sharing server definitions with a team via git, but each user still needs to provide their own credentials.

> **Note:** Claude Code manages MCP servers through the `claude mcp` CLI — not through `~/.claude/settings.json`. Adding `mcpServers` to `settings.json` directly will not work.

### 4. Connect a Matrix client

Download a Matrix client to chat with Claude:

| Platform | Client | Link |
|----------|--------|------|
| iOS / Android | Element | [App Store](https://apps.apple.com/app/element-messenger/id1083446067) / [Google Play](https://play.google.com/store/apps/details?id=im.vector.app) |
| Desktop | Element Desktop | [element.io/download](https://element.io/download) |
| Web | Element Web | Host via the Docker stack, or use your `https://element.yourdomain.com` |

Sign in with your admin account, create a room, and invite the bot (`@claude-bot:YOUR_DOMAIN`).

### 5. Start Claude Code

```bash
claude
```

The Matrix MCP server starts automatically when Claude Code launches. Send a message from your Matrix client — it will push directly into your Claude Code session as a channel notification. Claude can reply using the `matrix_send_message` tool.

## Available tools

| Tool | Description |
|------|-------------|
| `matrix_send_message` | Send a text message (with optional HTML) to a room |
| `matrix_send_notice` | Send a non-highlighted notice to a room |
| `matrix_read_messages` | Read recent messages from a room |
| `matrix_list_rooms` | List all rooms the bot has joined |
| `matrix_create_room` | Create a new room (encrypted by default) |
| `matrix_join_room` | Join a room by ID or alias |
| `matrix_invite_user` | Invite a user to a room |
| `matrix_set_typing` | Show or hide typing indicator |
| `matrix_enable_encryption` | Enable E2EE on an existing room |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MATRIX_HOMESERVER` | Yes | Your homeserver URL (e.g. `https://chat.yourdomain.com`) |
| `MATRIX_ACCESS_TOKEN` | Yes | Bot account access token |
| `MATRIX_USER_ID` | No | Bot user ID (informational) |
| `MATRIX_ALLOWED_USERS` | No | Comma-separated user IDs allowed to push messages into Claude |

## Easy button

Don't want to do this manually? Run the setup script:

```bash
./easy-button.sh
```

It walks you through the entire setup interactively — generates secrets, starts the containers, creates accounts, builds the MCP server, and writes your config files.

## How it works

The server runs as an MCP server over stdio. It connects to your Matrix homeserver using [matrix-bot-sdk](https://github.com/turt2live/matrix-bot-sdk) with the native Rust crypto provider for E2EE.

Claude Code automatically listens for `notifications/claude/channel` events from the server. Incoming Matrix messages are pushed into the conversation as `<channel source="matrix">` tags with room, sender, and timestamp metadata. Claude reads these and can reply using the MCP tools.

The crypto state is persisted in `~/.matrix-mcp-server/` so E2EE sessions survive restarts.

## Claude Desktop

Add the same config to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "matrix": {
      "command": "node",
      "args": ["/absolute/path/to/matrix-mcp-server/dist/index.js"],
      "env": {
        "MATRIX_HOMESERVER": "https://YOUR_DOMAIN",
        "MATRIX_ACCESS_TOKEN": "YOUR_BOT_ACCESS_TOKEN"
      }
    }
  }
}
```

Note: Claude Desktop supports MCP tools but does not currently support the channel push feature. Messages can be sent and read via tools but won't push automatically.

## License

MIT
