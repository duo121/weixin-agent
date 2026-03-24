import fs from "node:fs";
import path from "node:path";

import {
  resolveAgentRuntimePath,
  resolveAgentStateDir,
  resolveLegacyAgentRuntimePath,
} from "./paths.mjs";

function loadRuntimeStateAtPath(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function saveRuntimeStateAtPath(filePath, nextState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    ...nextState,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function clearRuntimeStateAtPath(filePath) {
  try {
    fs.unlinkSync(filePath);
    return { removed: true, filePath };
  } catch {
    return { removed: false, filePath };
  }
}

function inspectRuntimeStateAtPath(filePath, source) {
  const runtime = loadRuntimeStateAtPath(filePath);
  if (!runtime) {
    return null;
  }
  return {
    ...runtime,
    source,
    runtimePath: filePath,
    pidAlive: isProcessAlive(runtime.pid),
  };
}

export function loadRuntimeState() {
  return loadRuntimeStateAtPath(resolveAgentRuntimePath());
}

export function loadLegacyRuntimeState() {
  return loadRuntimeStateAtPath(resolveLegacyAgentRuntimePath());
}

export function saveRuntimeState(nextState) {
  fs.mkdirSync(resolveAgentStateDir(), { recursive: true });
  return saveRuntimeStateAtPath(resolveAgentRuntimePath(), nextState);
}

export function saveLegacyRuntimeState(nextState) {
  return saveRuntimeStateAtPath(resolveLegacyAgentRuntimePath(), nextState);
}

export function clearRuntimeState() {
  return clearRuntimeStateAtPath(resolveAgentRuntimePath());
}

export function clearLegacyRuntimeState() {
  return clearRuntimeStateAtPath(resolveLegacyAgentRuntimePath());
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function inspectRuntimeState() {
  return inspectRuntimeStateAtPath(resolveAgentRuntimePath(), "current");
}

export function inspectLegacyRuntimeState() {
  return inspectRuntimeStateAtPath(resolveLegacyAgentRuntimePath(), "legacy");
}

export function inspectKnownRuntimeStates() {
  return [
    inspectRuntimeState(),
    inspectLegacyRuntimeState(),
  ].filter(Boolean);
}

export function listActiveRuntimeStates() {
  return inspectKnownRuntimeStates().filter((runtime) => runtime.pidAlive);
}

export function listActiveRouterRuntimeStates() {
  return listActiveRuntimeStates().filter((runtime) => runtime.mode === "multi-agent-router");
}

export function saveInspectedRuntimeState(runtime, nextState) {
  const runtimePath = String(runtime?.runtimePath ?? "").trim();
  if (!runtimePath) {
    throw new Error("runtimePath is required to update an inspected runtime.");
  }

  const {
    pidAlive: _pidAlive,
    runtimePath: _runtimePath,
    source: _source,
    ...persisted
  } = runtime ?? {};

  return saveRuntimeStateAtPath(runtimePath, {
    ...persisted,
    ...nextState,
  });
}

export function buildBridgePlan({
  attach,
  accountId,
  cwd,
  passthrough,
  dryRun,
  mode = "terminal-inject",
  threadId = null,
  threadSource = null,
  foreground = false,
  terminalTarget = null,
}) {
  return {
    action: "bridge.start",
    attach,
    dryRun,
    mode,
    accountId,
    cwd,
    passthrough,
    foreground,
    sources: ["local-terminal", "wechat"],
    controller: {
      type: mode === "terminal-inject"
        ? "terminal-inject + codex-app-server-observe"
        : "codex-app-server-turn-start",
      threadId,
      threadSource,
      terminalTarget,
    },
    transport: {
      type: "weixin-ilink-http",
      inbound: ["text"],
      outbound: ["text"],
    },
    routing: {
      localInput: "render in local terminal",
      wechatInput: mode === "terminal-inject"
        ? "inject into current terminal Codex session, then reply to wechat"
        : "send turn via app-server, then reply to wechat",
    },
    sessionPolicy: {
      mode: "single-flight",
      onConflict: "queue or reject with busy message",
    },
    notes: attach === "current-codex"
      ? [
          mode === "terminal-inject"
            ? "current-codex attach injects inbound text into the active terminal tty and submits it as a real Codex turn"
            : "current-codex attach sends turns via the Codex app-server protocol",
          "blank Codex sessions need one local turn before they can be resumed externally",
          mode === "terminal-inject"
            ? terminalTarget
              ? `terminal target resolved: ${terminalTarget.handle}`
              : "no current terminal session was resolved; run bridge start in the frontmost Codex terminal or pass --session"
            : "terminal injection is disabled for this plan",
          threadId
            ? `target thread resolved: ${threadId}`
            : "no current Codex thread was resolved; run inside Codex or pass --thread-id",
        ]
      : [
          "unknown attach target",
        ],
  };
}
