# maxclaude-web

maxclaude-web opens named Claude Code sessions in a browser. A hub serves the interface. An agent on the session machine connects to the hub and controls Zellij sessions.

## Requirements

- Linux with systemd user services on the session machine
- Node.js 22 or later, npm, Zellij, and Claude Code on the session machine
- Docker and Docker Compose on the hub machine
- An HTTPS reverse proxy for remote browser access

Install the [maxclaude session tools](https://github.com/Gadgetguycj/maxclaude) first. Run its installer with the Claude provider. Create named sessions after starting the agent so Zellij enables web sharing before they start.

## Agent setup

Clone this repository on the session machine. Run `./agent/install.sh --no-start`. The installer copies the agent to `~/.local/share/maxclaude-web/agent`, installs its dependencies, and writes a systemd user unit.

Set `MCW_HUB_URL` in `~/.config/maxclaude-web/agent.env` to `wss://your-host.example.com/agent`. Set `MCW_DEFAULT_WORKDIR` there to an existing directory. Put the shared secret in `~/.config/maxclaude-web/tunnel.secret` with mode 0600. Use the same value for `AGENT_SECRET` on the hub. Then run `systemctl --user enable --now mcw-agent.service`.

Start a named session with `maxclaude work` after the agent is running.

The agent installer creates a random secret if its secret file is missing. Transfer it to the hub through a secure channel. It does not print the value.

## Hub setup

Copy `.env.example` to `.env`. Replace both placeholder values. Set `HUB_PORT` to an available local port. Start the hub with `docker compose up --build -d`. The compose file builds `web/Dockerfile` and keeps the database in a named volume.

Put an HTTPS reverse proxy in front of the hub and pass WebSocket upgrades. Route the browser interface and `/agent` to the hub. Keep the browser interface on a private network or behind authentication. The hub also requires its own operator sign in.

Sign in with the operator password. The session tree lists agent sessions. Open a named session to attach to its terminal.

## Environment

| Variable | Component | Purpose | Default |
| --- | --- | --- | --- |
| `OPERATOR_PASSWORD` | Hub | Initial sign in password | Required on first boot |
| `AGENT_SECRET` | Hub | Shared agent authentication value | Required |
| `HUB_PORT` | Compose | Local published port | `8080` |
| `DATA_DIR` | Hub | Persistent database directory | `/data` |
| `COOKIE_SECURE` | Hub | Require HTTPS browser cookies | `true` |
| `MCW_HUB_URL` | Agent | Outbound WebSocket URL | Example hostname |
| `MCW_SECRET_FILE` | Agent | Shared secret file | `~/.config/maxclaude-web/tunnel.secret` |
| `MCW_DEFAULT_WORKDIR` | Agent | New session working directory | `~/projects` |
| `MCW_TRANSCRIPT_DIR` | Agent | Claude transcript directory for that working directory | Derived from `MCW_DEFAULT_WORKDIR` |
| `MCW_FILES_ROOT` | Agent | Uploaded file root | `~/session-files` |
| `MCW_ZELLIJ_BIN` | Agent | Zellij executable | `~/.local/bin/zellij` |
| `MCW_AGENT_NAME` | Agent | Name shown in the hub | Machine hostname |

Additional tuning variables are in `web/src/config.js` and `agent/src/config.js`.

## Upgrade

Pull a reviewed release. Run `./agent/install.sh` on the session machine. Run `docker compose up --build -d` on the hub machine. Keep the compose volume across upgrades.

## Troubleshooting

- Agent offline: check `journalctl --user -u mcw-agent.service -n 100` and confirm the URL and shared secret match.
- Browser sign in fails: check the operator password and the hub logs with `docker compose logs hub`.
- Terminal fails to open: confirm the named session exists, Zellij web sharing is enabled, and the agent can run `zellij list-sessions`.
- No transcripts: set `MCW_TRANSCRIPT_DIR` to Claude Code's directory for the session working directory.
