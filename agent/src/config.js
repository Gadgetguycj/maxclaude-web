import path from 'node:path';
import os from 'node:os';

const env = process.env;
const home = os.homedir();
const configDir = env.XDG_CONFIG_HOME || path.join(home, '.config');
const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const stateDir = env.MCW_STATE_DIR || path.join(configDir, 'maxclaude-web');
const defaultWorkdir = env.MCW_DEFAULT_WORKDIR || path.join(home, 'projects');

export const config = {
  hubUrl: env.MCW_HUB_URL || 'wss://your-host.example.com/agent',
  stateDir,
  defaultWorkdir,
  secretFile: env.MCW_SECRET_FILE || path.join(stateDir, 'tunnel.secret'),
  tokenFile: env.MCW_TOKEN_FILE || path.join(stateDir, 'zellij-token.json'),
  statusDir: env.MCW_STATUS_DIR || path.join(stateDir, 'session-status'),
  filesRoot: env.MCW_FILES_ROOT || path.join(home, 'session-files'),
  projectsDir: env.MCW_PROJECTS_DIR || path.join(claudeDir, 'projects'),
  sessionEnvDir: env.MCW_SESSION_ENV_DIR || path.join(claudeDir, 'session-env'),
  zellijBin: env.MCW_ZELLIJ_BIN || path.join(home, '.local/bin/zellij'),
  zellijConfig: env.MCW_ZELLIJ_CONFIG || path.join(configDir, 'zellij/config.kdl'),
  webHost: env.MCW_WEB_HOST || '127.0.0.1',
  webPort: Number(env.MCW_WEB_PORT || 8082),
  maxclaudeCfg: env.MCW_MAXCLAUDE_CFG || path.join(configDir, 'maxclaude'),
  maxagentCfg: env.MCW_MAXAGENT_CFG || path.join(configDir, 'maxagent'),
  maxclaudeBin: env.MCW_MAXCLAUDE_BIN || path.join(home, '.local/bin/maxclaude'),
  sessionUnit: env.MCW_SESSION_UNIT || 'maxclaude-named',
  transcriptDir: env.MCW_TRANSCRIPT_DIR || path.join(claudeDir, 'projects', defaultWorkdir.replaceAll('/', '-')),
  claudeConfigDir: env.CLAUDE_CONFIG_DIR || claudeDir,
  agentName: env.MCW_AGENT_NAME || env.HOSTNAME || 'session-host',
  runtimeDir: env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
  version: 'mcw-agent/1.13.0',
  protocolVersion: 1,
  rpcTimeoutMs: 60000,
  createWaitMs: 20000,
  webWatchMs: 30000,
  statusWatchMs: 1000,
  // Native pane observation can take its documented 12-second timeout under
  // load. Keep the published source valid for one complete 20-second window.
  statusSourceLeaseMs: Number(env.MCW_STATUS_SOURCE_LEASE_MS || 20000),
  autoHibernateHours: Number(env.MCW_AUTO_HIBERNATE_HOURS || 0),
  autoHibernateWatchMs: 10 * 60 * 1000,
  // Usage meters. Each name is a model with its own weekly window in Claude's usage answer.
  usageModels: (env.MCW_USAGE_MODELS ?? 'Fable').split(',').map((name) => name.trim()).filter(Boolean),
  codexBin: env.MCW_CODEX_BIN || 'codex',
  usageMinIntervalMs: 60000,
  // Claude's usage endpoint answered every other request with 429 at one a minute.
  usageClaudeSpacingMs: 120000,
  usagePeriodMs: 5 * 60 * 1000,
};

if (!Number.isFinite(config.autoHibernateHours) || config.autoHibernateHours < 0) {
  throw new Error('MCW_AUTO_HIBERNATE_HOURS must be a non-negative number');
}
if (!/^[A-Za-z0-9:_.-]+$/.test(config.sessionUnit)) {
  throw new Error('MCW_SESSION_UNIT must be a systemd template name without @ or .service');
}
if (!Number.isFinite(config.statusSourceLeaseMs) || config.statusSourceLeaseMs < config.statusWatchMs || config.statusSourceLeaseMs > 20000) {
  throw new Error('MCW_STATUS_SOURCE_LEASE_MS must be between MCW_STATUS_WATCH_MS and 20000');
}

export const webOrigin = `http://${config.webHost}:${config.webPort}`;
export const webWsOrigin = `ws://${config.webHost}:${config.webPort}`;
