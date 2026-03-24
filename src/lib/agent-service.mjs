import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import {
  createAgentRecord,
  deleteAgentRecord,
  findAgentsByDisplayName,
  findAgentByDisplayName,
  findAgentBySessionHandle,
  loadAgent,
  markAgentDisconnected,
  renameAgent,
  updateAgent,
} from "./agents.mjs";
import { clearConversationAgentReferences } from "./conversations.mjs";
import { appendEvent } from "./events.mjs";
import { CLIError } from "./errors.mjs";
import { resolveAgentConnectionLogPath } from "./paths.mjs";
import { inspectRuntimeState } from "./runtime.mjs";
import { resolveCurrentTerminalTarget } from "./terminal-control.mjs";
import { failPendingTicketsForAgent } from "./tickets.mjs";

function routerIsRunning() {
  const runtime = inspectRuntimeState();
  if (!runtime?.pidAlive) {
    return false;
  }
  return runtime.mode === "multi-agent-router";
}

function agentRuntimeSnapshot(agent, target) {
  const currentTicketId = agent.currentTicketId ?? null;
  return {
    status: currentTicketId ? "busy" : "connected",
    target,
    sessionHandle: target.handle,
    sessionApp: target.app,
    pid: process.pid,
    connectedAt: agent.connectedAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    disconnectedAt: null,
    lastError: null,
  };
}

export function ensureAgentConnectPlan({
  terminalTarget,
  kind,
  requestedName = null,
  foreground = false,
  dryRun = false,
}) {
  return {
    action: "connect",
    dryRun,
    foreground,
    routerRequired: true,
    terminalTarget,
    requestedName: requestedName ?? null,
    kind,
    notes: [
      terminalTarget
        ? `target terminal session resolved: ${terminalTarget.handle}`
        : "no terminal session was resolved; pass --session or run connect in the target terminal",
      requestedName
        ? `requested name: ${requestedName}`
        : "no name requested yet; connect requires an explicit full display name",
      `kind: ${kind}`,
      "connect registers one AI terminal session into the global WeChat router",
    ],
  };
}

export function assertAgentConnectable({
  terminalTarget,
}) {
  if (!routerIsRunning()) {
    throw new CLIError("ROUTER_NOT_RUNNING", "The global weixin-agent router is not running. Run `weixin-agent start` first.");
  }

  if (!terminalTarget) {
    throw new CLIError("TERMINAL_SESSION_REQUIRED", "No terminal session was resolved. Pass --session or run connect in the target terminal.");
  }
}

export function startDetachedAgentConnection({
  terminalTarget,
  requestedName = null,
  kind = "agent",
  cwd,
  launchProfile = null,
}) {
  const cliPath = path.resolve(process.argv[1]);
  const agent = createAgentRecord({
    terminalTarget,
    requestedName,
    kind,
    cwd,
    launchProfile,
  });
  const logPath = resolveAgentConnectionLogPath(agent.id);

  const childArgs = [
    cliPath,
    "__agent-run",
    "--agent-id",
    agent.id,
    "--cwd",
    cwd,
    "--app",
    terminalTarget.app,
    "--session",
    terminalTarget.handle,
  ];

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(process.execPath, childArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  fs.closeSync(logFd);

  const next = updateAgent(agent.id, {
    pid: child.pid,
    logPath,
  });

  appendEvent({
    type: "agent.connect.spawned",
    payload: {
      agentId: agent.id,
      displayName: next?.displayName ?? agent.displayName,
      pid: child.pid,
      sessionHandle: terminalTarget.handle,
      kind,
      requestedName,
    },
  });

  return next;
}

export async function runAgentConnectionProcess({
  agentId,
  cwd,
  terminalApp = null,
  terminalSession = null,
}) {
  const agent = loadAgent(agentId);
  if (!agent) {
    throw new CLIError("AGENT_NOT_FOUND", `Agent ${agentId} was not found.`, {
      agentId,
    });
  }

  const abortController = new AbortController();
  let stopReason = null;

  const onSigint = () => {
    stopReason = "SIGINT";
    abortController.abort();
  };
  const onSigterm = () => {
    stopReason = "SIGTERM";
    abortController.abort();
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const refreshTarget = async () => resolveCurrentTerminalTarget({
    app: terminalApp,
    session: terminalSession,
  });

  const saveHeartbeat = async () => {
    const current = loadAgent(agentId);
    if (!current) {
      throw new CLIError("AGENT_NOT_FOUND", `Agent ${agentId} was removed while running.`, {
        agentId,
      });
    }
    const target = await refreshTarget();
    updateAgent(agentId, agentRuntimeSnapshot(current, target));
  };

  const heartbeat = setInterval(() => {
    saveHeartbeat().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      updateAgent(agentId, {
        status: "error",
        lastError: message,
      });
      abortController.abort();
    });
  }, 15_000);
  const routerProbe = setInterval(() => {
    if (!routerIsRunning()) {
      stopReason = stopReason ?? "router_stopped";
      abortController.abort();
    }
  }, 5_000);

  routerProbe.unref();

  try {
    await saveHeartbeat();

    const connected = loadAgent(agentId);
    appendEvent({
      type: "agent.connected",
      payload: {
        agentId,
        displayName: connected?.displayName ?? agent.displayName,
        pid: process.pid,
        sessionHandle: connected?.sessionHandle ?? terminalSession,
      },
    });

    await new Promise((resolve) => {
      if (abortController.signal.aborted) {
        resolve();
        return;
      }
      abortController.signal.addEventListener("abort", resolve, { once: true });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateAgent(agentId, {
      status: "error",
      lastError: message,
      disconnectedAt: new Date().toISOString(),
      currentTicketId: null,
    });
    appendEvent({
      type: "agent.crashed",
      payload: {
        agentId,
        error: message,
      },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearInterval(routerProbe);
    if (stopReason) {
      markAgentDisconnected(agentId, stopReason);
    }
    appendEvent({
      type: "agent.disconnected",
      payload: {
        agentId,
        reason: stopReason ?? "completed",
      },
    });
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export function disconnectAgentByRecord(agent, { force = false } = {}) {
  if (!agent) {
    throw new CLIError("AGENT_NOT_FOUND", "No matching connected agent was found.");
  }

  if (agent.currentTicketId && !force) {
    throw new CLIError("AGENT_BUSY", `Agent ${agent.displayName} is still processing ticket ${agent.currentTicketId}.`, {
      agentId: agent.id,
      ticketId: agent.currentTicketId,
    });
  }

  if (agent.pidAlive) {
    process.kill(agent.pid, "SIGTERM");
  }

  const next = updateAgent(agent.id, {
    status: "disconnecting",
    disconnectRequestedAt: new Date().toISOString(),
    currentTicketId: force ? null : agent.currentTicketId,
  });

  appendEvent({
    type: "agent.disconnect.requested",
    payload: {
      agentId: agent.id,
      displayName: agent.displayName,
      sessionHandle: agent.sessionHandle,
      force,
    },
  });

  return next;
}

export function disconnectAgent({
  agentId = null,
  sessionHandle = null,
  displayName = null,
  force = false,
}) {
  let agent = null;

  if (agentId) {
    agent = loadAgent(agentId);
  } else if (sessionHandle) {
    agent = findAgentBySessionHandle(sessionHandle, { onlyLive: true });
  } else if (displayName) {
    agent = findAgentByDisplayName(displayName, { onlyLive: true });
  }

  return disconnectAgentByRecord(agent, { force });
}

export function renameSelfAgent({
  terminalTarget,
  requestedName,
}) {
  const agent = findAgentBySessionHandle(terminalTarget?.handle, { onlyLive: true });
  if (!agent) {
    throw new CLIError("AGENT_NOT_CONNECTED", "The current terminal session is not connected as an online agent.", {
      sessionHandle: terminalTarget?.handle ?? null,
    });
  }

  const next = renameAgent(agent.id, requestedName);
  appendEvent({
    type: "agent.renamed",
    payload: {
      agentId: agent.id,
      previousName: agent.displayName,
      displayName: next.displayName,
      sessionHandle: agent.sessionHandle,
    },
  });
  return next;
}

export function renameConnectedAgent({
  agentId = null,
  sessionHandle = null,
  displayName = null,
  requestedName,
}) {
  let agent = null;

  if (agentId) {
    agent = loadAgent(agentId);
  } else if (sessionHandle) {
    agent = findAgentBySessionHandle(sessionHandle, { onlyLive: true });
  } else if (displayName) {
    agent = findAgentByDisplayName(displayName, { onlyLive: true });
  }

  if (!agent) {
    throw new CLIError("AGENT_NOT_FOUND", "No matching connected agent was found.");
  }

  const next = renameAgent(agent.id, requestedName);
  appendEvent({
    type: "agent.renamed",
    payload: {
      agentId: agent.id,
      previousName: agent.displayName,
      displayName: next.displayName,
      sessionHandle: agent.sessionHandle,
    },
  });
  return next;
}

export function removeAgentsByDisplayName(displayName, {
  force = true,
} = {}) {
  const agents = findAgentsByDisplayName(displayName, { onlyLive: false });
  if (agents.length === 0) {
    throw new CLIError("AGENT_NOT_FOUND", `No known agent named ${displayName} was found.`, {
      displayName,
    });
  }

  const removed = [];
  const removedIds = [];
  for (const agent of agents) {
    if (agent.pidAlive) {
      if (agent.currentTicketId && !force) {
        throw new CLIError("AGENT_BUSY", `Agent ${agent.displayName} is still processing ticket ${agent.currentTicketId}.`, {
          agentId: agent.id,
          ticketId: agent.currentTicketId,
        });
      }
      try {
        process.kill(agent.pid, "SIGTERM");
      } catch {
        // best effort
      }
    }

    failPendingTicketsForAgent(agent.id, {
      status: "failed",
      errorMessage: "agent removed by /remove",
    });

    const deleted = deleteAgentRecord(agent.id);
    if (deleted) {
      removed.push(deleted);
      removedIds.push(agent.id);
      appendEvent({
        type: "agent.removed",
        payload: {
          agentId: agent.id,
          displayName: agent.displayName,
          force,
        },
      });
    }
  }

  clearConversationAgentReferences({
    agentName: displayName,
    agentIds: removedIds,
  });

  return {
    removed,
    removedCount: removed.length,
  };
}
