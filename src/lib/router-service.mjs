import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { loadAccountCredentials } from "./accounts.mjs";
import { appendEvent } from "./events.mjs";
import { CLIError } from "./errors.mjs";
import { resolveAgentRouterLogPath } from "./paths.mjs";
import {
  inspectKnownRuntimeStates,
  inspectRuntimeState,
  listActiveRouterRuntimeStates,
  listActiveRuntimeStates,
  saveInspectedRuntimeState,
  saveRuntimeState,
} from "./runtime.mjs";
import { runWeixinRouter } from "./router-runtime.mjs";

function routerRuntimeSnapshot({
  runId,
  status,
  accountId,
  cwd,
  pid,
  logPath,
  startedAt,
  stoppedAt = null,
  stopReason = null,
  lastError = null,
  heartbeatAt = null,
}) {
  return {
    runId,
    status,
    mode: "multi-agent-router",
    accountId,
    cwd,
    pid,
    logPath,
    startedAt,
    stoppedAt,
    stopReason,
    lastError,
    heartbeatAt,
  };
}

export function ensureRouterStartPlan({
  accountId,
  cwd,
  foreground = false,
  dryRun = false,
}) {
  return {
    action: "start",
    mode: "multi-agent-router",
    dryRun,
    foreground,
    accountId,
    cwd,
    sources: ["wechat", "local-agent-sessions"],
    notes: [
      accountId
        ? `selected account: ${accountId}`
        : "no account selected; run account login or pass --account",
      "start only launches the global router daemon",
      "the router may run with zero connected agents",
      "connect --session attaches one Codex/Claude/local AI session into the running router",
    ],
  };
}

export function assertRouterStartable({
  accountId,
}) {
  if (!accountId) {
    throw new CLIError("ACCOUNT_REQUIRED", "Select a WeChat account before starting the router.");
  }

  const activeRuntimes = listActiveRuntimeStates();
  const activeRouterRuntimes = activeRuntimes.filter((runtime) => runtime.mode === "multi-agent-router");

  if (activeRouterRuntimes.length > 0) {
    throw new CLIError("ROUTER_ALREADY_RUNNING", "A global weixin-agent router daemon is already running. Stop every active router before starting a new one.", {
      runtimes: activeRouterRuntimes,
    });
  }

  if (activeRuntimes.length > 0) {
    throw new CLIError("LEGACY_RUNTIME_ACTIVE", "Another weixin-agent runtime is still active. Stop it before starting the multi-agent router.", {
      runtimes: activeRuntimes,
    });
  }
}

export function startDetachedRouter({
  accountId,
  cwd,
}) {
  assertRouterStartable({ accountId });

  const runId = randomUUID();
  const cliPath = path.resolve(process.argv[1]);
  const logPath = resolveAgentRouterLogPath(runId);
  const startedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(process.execPath, [
    cliPath,
    "__router-run",
    "--account",
    accountId,
    "--cwd",
    cwd,
    "--run-id",
    runId,
  ], {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  fs.closeSync(logFd);

  const runtime = saveRuntimeState(routerRuntimeSnapshot({
    runId,
    status: "starting",
    accountId,
    cwd,
    pid: child.pid,
    logPath,
    startedAt,
  }));

  appendEvent({
    type: "router.start.spawned",
    accountId,
    payload: {
      runId,
      pid: child.pid,
      cwd,
      logPath,
    },
  });

  return runtime;
}

export async function runRouterProcess({
  accountId,
  cwd,
  runId = randomUUID(),
}) {
  const account = loadAccountCredentials(accountId);
  if (!account?.configured || !account.token) {
    throw new CLIError("ACCOUNT_NOT_CONFIGURED", `Account ${accountId} is missing a token.`, {
      accountId,
    });
  }

  const startedAt = new Date().toISOString();
  const logPath = resolveAgentRouterLogPath(runId);
  const abortController = new AbortController();
  let stopReason = null;

  const saveHeartbeat = () => saveRuntimeState(routerRuntimeSnapshot({
    runId,
    status: abortController.signal.aborted ? "stopping" : "running",
    accountId,
    cwd,
    pid: process.pid,
    logPath,
    startedAt,
    heartbeatAt: new Date().toISOString(),
  }));

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

  const heartbeat = setInterval(saveHeartbeat, 15_000);

  try {
    saveHeartbeat();
    appendEvent({
      type: "router.started",
      accountId,
      payload: {
        runId,
        pid: process.pid,
        cwd,
      },
    });

    await runWeixinRouter({
      account,
      abortSignal: abortController.signal,
    });

    saveRuntimeState(routerRuntimeSnapshot({
      runId,
      status: "stopped",
      accountId,
      cwd,
      pid: process.pid,
      logPath,
      startedAt,
      stoppedAt: new Date().toISOString(),
      stopReason: stopReason ?? "completed",
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveRuntimeState(routerRuntimeSnapshot({
      runId,
      status: "error",
      accountId,
      cwd,
      pid: process.pid,
      logPath,
      startedAt,
      stoppedAt: new Date().toISOString(),
      stopReason,
      lastError: message,
    }));
    appendEvent({
      type: "router.crashed",
      accountId,
      payload: {
        runId,
        error: message,
      },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export function stopRunningRouter() {
  const runtimes = inspectKnownRuntimeStates();
  const activeRouters = listActiveRouterRuntimeStates();

  if (activeRouters.length === 0) {
    return {
      stopped: false,
      reason: "not_running",
      runtime: inspectRuntimeState(),
      runtimes,
    };
  }

  const stopRequestedAt = new Date().toISOString();
  const results = activeRouters.map((runtime) => {
    try {
      process.kill(runtime.pid, "SIGTERM");
      const next = saveInspectedRuntimeState(runtime, {
        status: "stopping",
        stopRequestedAt,
      });
      return {
        source: runtime.source,
        stopped: true,
        runtime: {
          ...next,
          source: runtime.source,
          runtimePath: runtime.runtimePath,
          pidAlive: true,
        },
      };
    } catch (error) {
      return {
        source: runtime.source,
        stopped: false,
        error: error instanceof Error ? error.message : String(error),
        runtime,
      };
    }
  });

  const stoppedRuntimes = results.filter((entry) => entry.stopped);
  const currentRuntime = results.find((entry) => entry.source === "current")?.runtime ?? inspectRuntimeState();

  appendEvent({
    type: "router.stop.requested",
    accountId: activeRouters[0]?.accountId ?? null,
    payload: {
      runtimes: activeRouters.map((runtime) => ({
        source: runtime.source,
        runId: runtime.runId ?? null,
        pid: runtime.pid,
        runtimePath: runtime.runtimePath ?? null,
      })),
    },
  });

  return {
    stopped: stoppedRuntimes.length > 0,
    reason: stoppedRuntimes.length > 0 ? "signal_sent" : "stop_failed",
    runtime: currentRuntime,
    runtimes: results,
    stoppedCount: stoppedRuntimes.length,
  };
}
