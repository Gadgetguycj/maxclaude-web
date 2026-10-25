#!/usr/bin/env bash
# Install or update the session agent. Re-runnable.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${MCW_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/maxclaude-web}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
INSTALL_DIR="$HOME/.local/share/maxclaude-web/agent"
SECRET_FILE="$STATE_DIR/tunnel.secret"
START=1

for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    *) echo "unknown argument: $arg (want --no-start)" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }

install -d -m 700 "$STATE_DIR"
install -d -m 755 "$UNIT_DIR"
install -d -m 755 "$HOME/.local/bin"
install -m 755 "$HERE/bin/mcw-session-status" "$HOME/.local/bin/mcw-session-status"
install -m 755 "$HERE/bin/mcw-status-events.py" "$HOME/.local/bin/mcw-status-events.py"

if [ ! -s "$SECRET_FILE" ]; then
  umask 077
  openssl rand -hex 32 > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "generated a new tunnel secret at $SECRET_FILE"
  echo "configure the same secret in the hub environment"
else
  chmod 600 "$SECRET_FILE"
  echo "tunnel secret already present at $SECRET_FILE"
fi

if [ ! -f "$STATE_DIR/agent.env" ]; then
  umask 077
  printf 'MCW_HUB_URL=wss://your-host.example.com/agent\n' > "$STATE_DIR/agent.env"
  chmod 600 "$STATE_DIR/agent.env"
  echo "wrote $STATE_DIR/agent.env"
fi

install -d -m 755 "$INSTALL_DIR"
cp -R "$HERE/src" "$HERE/bin" "$HERE/package.json" "$HERE/package-lock.json" "$INSTALL_DIR/"
( cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund )

install -m 644 "$HERE/mcw-agent.service" "$UNIT_DIR/mcw-agent.service"
if ! loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
  echo "could not enable lingering; ask an administrator to enable it if sessions must survive logout" >&2
fi
systemctl --user daemon-reload
systemctl --user enable mcw-agent.service

if [ "$START" = 1 ]; then
  systemctl --user restart mcw-agent.service
  sleep 2
  systemctl --user --no-pager --full status mcw-agent.service | head -20
fi

# maxclaude session units are started on demand and must never gain an [Install]
# section, so this install deliberately enables nothing but mcw-agent itself.
echo "installed. logs: journalctl --user -u mcw-agent.service -f"
