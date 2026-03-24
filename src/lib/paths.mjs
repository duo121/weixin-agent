import os from "node:os";
import path from "node:path";

const LEGACY_STATE_ENV_KEYS = Object.freeze([
  ["OPEN", "CLAW", "_STATE_DIR"].join(""),
  ["CLAW", "DBOT", "_STATE_DIR"].join(""),
]);
const LEGACY_HOME_DIRNAME = `.${["open", "claw"].join("")}`;
const LEGACY_WEIXIN_DIRNAME = [["open", "claw"].join(""), "weixin"].join("-");

export function resolveWeixinAgentHomeDir() {
  return process.env.WEIXIN_AGENT_HOME?.trim() || path.join(os.homedir(), ".weixin-agent");
}

export function resolveStateDir() {
  return resolveWeixinAgentHomeDir();
}

export function resolveWeixinStateDir() {
  return resolveWeixinAgentHomeDir();
}

export function resolveWeixinAccountsDir() {
  return path.join(resolveWeixinStateDir(), "accounts");
}

export function resolveWeixinAccountsIndexPath() {
  return path.join(resolveWeixinAccountsDir(), "index.json");
}

export function resolveWeixinSyncBufPath(accountId) {
  return path.join(resolveWeixinAccountsDir(), `${accountId}.sync.json`);
}

export function resolveAgentStateDir() {
  return resolveWeixinAgentHomeDir();
}

export function resolveAgentConfigPath() {
  return process.env.WEIXIN_AGENT_CONFIG?.trim() || path.join(resolveWeixinAgentHomeDir(), "config.json");
}

export function resolveAgentRuntimePath() {
  return path.join(resolveAgentStateDir(), "runtime.json");
}

export function resolveAgentAgentsDir() {
  return path.join(resolveAgentStateDir(), "agents");
}

export function resolveAgentAgentPath(agentId) {
  return path.join(resolveAgentAgentsDir(), `${String(agentId).trim()}.json`);
}

export function resolveAgentTicketsDir() {
  return path.join(resolveAgentStateDir(), "tickets");
}

export function resolveAgentInboundMediaDir() {
  return path.join(resolveAgentStateDir(), "inbound-media");
}

export function resolveAgentConversationRoutesDir() {
  return path.join(resolveAgentStateDir(), "conversations");
}

export function resolveAgentConversationHistoryDir() {
  return path.join(resolveAgentStateDir(), "history");
}

export function resolveAgentAccountHistoryPath(accountId) {
  const safeAccountId = encodeURIComponent(String(accountId ?? "").trim() || "unknown-account");
  return path.join(resolveAgentConversationHistoryDir(), `${safeAccountId}.jsonl`);
}

export function resolveAgentConversationRoutePath(accountId, conversationId) {
  const safeAccountId = encodeURIComponent(String(accountId).trim());
  const safeConversationId = encodeURIComponent(String(conversationId).trim());
  return path.join(
    resolveAgentConversationRoutesDir(),
    `${safeAccountId}--${safeConversationId}.json`,
  );
}

export function resolveAgentEventsPath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(resolveAgentStateDir(), `events-${today}.jsonl`);
}

export function resolveAgentBridgeLogPath(runId = null) {
  return path.join(resolveAgentStateDir(), runId ? `bridge-${runId}.log` : "bridge.log");
}

export function resolveAgentRouterLogPath(runId = null) {
  return path.join(resolveAgentStateDir(), runId ? `router-${runId}.log` : "router.log");
}

export function resolveAgentConnectionLogPath(agentId) {
  return path.join(resolveAgentStateDir(), `agent-${String(agentId).trim()}.log`);
}

export function resolveLegacyCompatStateDir() {
  for (const key of LEGACY_STATE_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return path.join(os.homedir(), LEGACY_HOME_DIRNAME);
}

export function resolveLegacyCompatWeixinStateDir() {
  return path.join(resolveLegacyCompatStateDir(), LEGACY_WEIXIN_DIRNAME);
}

export function resolveLegacyWeixinAccountsDir() {
  return path.join(resolveLegacyCompatWeixinStateDir(), "accounts");
}

export function resolveLegacyWeixinAccountsIndexPath() {
  return path.join(resolveLegacyCompatWeixinStateDir(), "accounts.json");
}

export function resolveLegacyAgentStateDir() {
  return path.join(resolveLegacyCompatStateDir(), "weixin-agent");
}

export function resolveLegacyAgentRuntimePath() {
  return path.join(resolveLegacyAgentStateDir(), "runtime.json");
}

export function resolveCodexStateDir() {
  return path.join(os.homedir(), ".codex");
}

export function resolveCodexSessionIndexPath() {
  return path.join(resolveCodexStateDir(), "session_index.jsonl");
}
