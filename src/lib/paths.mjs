import os from "node:os";
import path from "node:path";

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

export function resolveLegacyOpenClawStateDir() {
  return (
    process.env.OPENCLAW_STATE_DIR?.trim()
    || process.env.CLAWDBOT_STATE_DIR?.trim()
    || path.join(os.homedir(), ".openclaw")
  );
}

export function resolveLegacyWeixinStateDir() {
  return path.join(resolveLegacyOpenClawStateDir(), "openclaw-weixin");
}

export function resolveLegacyWeixinAccountsDir() {
  return path.join(resolveLegacyWeixinStateDir(), "accounts");
}

export function resolveLegacyWeixinAccountsIndexPath() {
  return path.join(resolveLegacyWeixinStateDir(), "accounts.json");
}

export function resolveLegacyAgentStateDir() {
  return path.join(resolveLegacyOpenClawStateDir(), "weixin-agent");
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
