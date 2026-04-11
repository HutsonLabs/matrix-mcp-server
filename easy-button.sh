#!/usr/bin/env bash
set -euo pipefail

# Matrix MCP Server — Easy Setup
# Walks you through the entire setup interactively.

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}==>${NC} ${BOLD}$*${NC}"; }
warn()  { echo -e "${YELLOW}==> WARNING:${NC} $*"; }
error() { echo -e "${RED}==> ERROR:${NC} $*"; exit 1; }
ask()   { echo -en "${GREEN}==>${NC} ${BOLD}$1${NC} "; read -r "$2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/matrix-server"

echo ""
echo -e "${BOLD}Matrix MCP Server — Easy Setup${NC}"
echo -e "${DIM}This script sets up a Matrix homeserver and configures Claude Code to use it.${NC}"
echo ""

# ── Check prerequisites ──

info "Checking prerequisites..."

command -v node >/dev/null 2>&1 || error "Node.js is required. Install it: https://nodejs.org"
command -v npm >/dev/null 2>&1  || error "npm is required. Install it with Node.js."

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  error "Node.js 22+ is required (found v$(node -v)). Update: https://nodejs.org"
fi

if command -v docker >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE_CMD="podman-compose"
elif command -v podman >/dev/null 2>&1 && podman compose --help >/dev/null 2>&1; then
  COMPOSE_CMD="podman compose"
else
  warn "Docker/Podman not found. Skipping homeserver setup."
  warn "You'll need to set up a Matrix homeserver manually."
  COMPOSE_CMD=""
fi

echo -e "  Node.js $(node -v) ${GREEN}OK${NC}"
[ -n "$COMPOSE_CMD" ] && echo -e "  Container runtime ${GREEN}OK${NC} ($COMPOSE_CMD)"
echo ""

# ── Domain ──

ask "Enter your Matrix domain (e.g. chat.example.com):" DOMAIN
[ -z "$DOMAIN" ] && error "Domain is required."
echo ""

# ── Set up homeserver (optional) ──

SETUP_SERVER="n"
if [ -n "$COMPOSE_CMD" ]; then
  ask "Set up a new Matrix homeserver with Docker? [y/N]" SETUP_SERVER
fi

if [[ "$SETUP_SERVER" =~ ^[Yy] ]]; then
  info "Setting up Matrix homeserver..."

  # Generate secrets
  DB_PASS=$(openssl rand -hex 32)
  MACAROON=$(openssl rand -hex 64)
  FORM_SECRET=$(openssl rand -hex 64)
  REG_SECRET=$(openssl rand -hex 64)

  # Write .env
  cat > "$SERVER_DIR/.env" <<EOF
POSTGRES_PASSWORD=$DB_PASS
EOF

  # Write homeserver.yaml from template
  sed \
    -e "s|YOUR_DOMAIN|$DOMAIN|g" \
    -e "s|CHANGE_ME_match_POSTGRES_PASSWORD|$DB_PASS|g" \
    -e "s|CHANGE_ME_generate_a_random_secret_key_here|$MACAROON|g" \
    -e "s|CHANGE_ME_generate_another_random_secret_here|$FORM_SECRET|g" \
    -e "s|CHANGE_ME_generate_a_third_random_secret_here|$REG_SECRET|g" \
    "$SERVER_DIR/synapse-data/homeserver.yaml.example" \
    > "$SERVER_DIR/synapse-data/homeserver.yaml"

  # Write Element config from template
  sed "s|YOUR_DOMAIN|$DOMAIN|g" \
    "$SERVER_DIR/element/config.json.example" \
    > "$SERVER_DIR/element/config.json"

  # Generate signing key
  info "Generating Synapse signing key..."
  cd "$SERVER_DIR"
  $COMPOSE_CMD run --rm synapse generate 2>/dev/null || true

  # Start the stack
  info "Starting Matrix homeserver..."
  $COMPOSE_CMD up -d

  # Wait for Synapse to be healthy
  info "Waiting for Synapse to be ready..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:8008/health >/dev/null 2>&1; then
      echo -e "  Synapse is ready ${GREEN}OK${NC}"
      break
    fi
    sleep 2
    if [ "$i" -eq 30 ]; then
      error "Synapse didn't start in 60 seconds. Check: $COMPOSE_CMD logs synapse"
    fi
  done

  # Create admin account
  echo ""
  ask "Choose an admin username:" ADMIN_USER
  ask "Choose an admin password:" ADMIN_PASS
  [ -z "$ADMIN_USER" ] && error "Username required."
  [ -z "$ADMIN_PASS" ] && error "Password required."

  info "Creating admin account @$ADMIN_USER:$DOMAIN..."
  $COMPOSE_CMD exec -T synapse register_new_matrix_user \
    -c /data/homeserver.yaml --no-ssl \
    -u "$ADMIN_USER" -p "$ADMIN_PASS" -a \
    http://localhost:8008

  # Create bot account
  BOT_USER="claude-bot"
  BOT_PASS=$(openssl rand -hex 16)

  info "Creating bot account @$BOT_USER:$DOMAIN..."
  $COMPOSE_CMD exec -T synapse register_new_matrix_user \
    -c /data/homeserver.yaml --no-ssl \
    -u "$BOT_USER" -p "$BOT_PASS" \
    http://localhost:8008

  # Disable registration
  sed -i.bak 's/enable_registration: true/enable_registration: false/' \
    "$SERVER_DIR/synapse-data/homeserver.yaml" 2>/dev/null || true
  $COMPOSE_CMD restart synapse >/dev/null 2>&1

  # Get bot access token
  info "Getting bot access token..."
  TOKEN_RESPONSE=$(curl -s -X POST "http://localhost:8008/_matrix/client/v3/login" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"m.login.password\",\"user\":\"$BOT_USER\",\"password\":\"$BOT_PASS\"}")
  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$ACCESS_TOKEN" ]; then
    error "Failed to get access token. Response: $TOKEN_RESPONSE"
  fi

  echo -e "  Bot token obtained ${GREEN}OK${NC}"
  cd "$SCRIPT_DIR"
else
  echo ""
  ask "Enter your bot's access token:" ACCESS_TOKEN
  [ -z "$ACCESS_TOKEN" ] && error "Access token is required."
  BOT_USER="claude-bot"
  ask "Enter the bot's username (default: claude-bot):" BOT_INPUT
  [ -n "$BOT_INPUT" ] && BOT_USER="$BOT_INPUT"
fi

echo ""

# ── Build the MCP server ──

info "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --silent 2>&1

info "Building MCP server..."
npm run build --silent 2>&1
echo -e "  Build complete ${GREEN}OK${NC}"

# ── Write .mcp.json ──

info "Writing .mcp.json..."
cat > "$SCRIPT_DIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "matrix": {
      "command": "node",
      "args": [
        "$SCRIPT_DIR/dist/index.js"
      ],
      "env": {
        "MATRIX_HOMESERVER": "https://$DOMAIN",
        "MATRIX_ACCESS_TOKEN": "$ACCESS_TOKEN",
        "MATRIX_USER_ID": "@$BOT_USER:$DOMAIN"
      }
    }
  }
}
EOF

echo -e "  .mcp.json written ${GREEN}OK${NC}"
echo ""

# ── Summary ──

info "Setup complete!"
echo ""
echo -e "${BOLD}Your Matrix homeserver:${NC}"
echo "  Domain:      $DOMAIN"
echo "  Synapse:     http://localhost:8008"
[ -n "$COMPOSE_CMD" ] && [[ "$SETUP_SERVER" =~ ^[Yy] ]] && echo "  Element:     http://localhost:8009"
echo ""
echo -e "${BOLD}Bot account:${NC}"
echo "  User:        @$BOT_USER:$DOMAIN"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo ""
echo "  1. Set up a reverse proxy for https://$DOMAIN -> localhost:8008"
echo ""
echo "  2. Connect a Matrix client (Element, FluffyChat, etc.)"
echo "     Sign in as your admin account and create a room."
echo "     Invite @$BOT_USER:$DOMAIN to the room."
echo ""
echo "  3. Start Claude Code with the channel enabled:"
echo ""
echo -e "     ${BOLD}claude --dangerously-load-development-channels server:matrix${NC}"
echo ""
echo "  4. Send a message from your Matrix client — it will appear in Claude Code!"
echo ""
