#!/bin/bash
# Starts the Podman machine and Matrix containers at boot.
# Installed as /Library/LaunchDaemons/com.homelab.matrix.plist
# Runs as root, but delegates podman commands to the homelab user.

set -euo pipefail

COMPOSE_DIR="/path/to/matrix-mcp-server/matrix-server"
PODMAN="/opt/homebrew/bin/podman"
PODMAN_COMPOSE="/opt/homebrew/bin/podman-compose"
HOMELAB_USER="homelab"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [matrix-start] $*" ; }

run_as_homelab() {
    /bin/launchctl asuser 501 /usr/bin/sudo -u "$HOMELAB_USER" \
        /usr/bin/env \
        HOME="/Users/$HOMELAB_USER" \
        PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
        "$@"
}

log "Starting Podman machine..."
run_as_homelab "$PODMAN" machine start --no-info || true

# Wait until the podman socket is responsive (up to 120s)
log "Waiting for Podman to be ready..."
for i in $(seq 1 24); do
    if run_as_homelab "$PODMAN" info >/dev/null 2>&1; then
        log "Podman is ready (attempt $i)"
        break
    fi
    sleep 5
    if [ "$i" -eq 24 ]; then
        log "ERROR: Podman not ready after 120s, aborting"
        exit 1
    fi
done

log "Starting Matrix containers..."
cd "$COMPOSE_DIR"
run_as_homelab "$PODMAN_COMPOSE" up -d

log "Matrix stack is up."
