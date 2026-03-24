import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { loadAccountCredentials } from "./accounts.mjs";
import { CodexSessionController } from "./codex-session.mjs";
import { appendEvent } from "./events.mjs";
import { CLIError } from "./errors.mjs";
import { resolveAgentBridgeLogPath } from "./paths.mjs";
import { inspectRuntimeState, isProcessAlive, loadRuntimeState, saveRuntimeState } from "./runtime.mjs";
import { resolveCurrentTerminalTarget } from "./terminal-control.mjs";
import { runWeixinBridge } from "./wechat-runtime.mjs";

function runtimeSnapshot({
  runId,
  status,
  attach,
  mode,
  accountId,
  threadId,
  cwd,
  terminal = null,
  appServer = null,
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
    attach,
    mode,
    accountId,
    threadId,
    cwd,
    terminal,
    appServer,
    pid,
    logPath,
    startedAt,
    stoppedAt,
    stopReason,
    lastError,
    heartbeatAt,
  };
}

export function assertBridgeStartable({
  attach,
  accountId,
  threadId,
  mode = "terminal-inject",
  terminalTarget = null,
}) {
  if (attach !== "current-codex") {
    throw new CLIError("UNSUPPORTED_ATTACH_TARGET", `Unsupported attach target: ${attach}`, {
      attach,
    });
  }

  if (!accountId) {
    throw new CLIError("ACCOUNT_REQUIRED", "Select a WeChat account before starting the bridge.");
  }

  if (!threadId) {
    throw new CLIError(
      "CODEX_THREAD_REQUIRED",
      "No current Codex thread was found. Run inside Codex or pass --thread-id.",
    );
  }

  if (mode === "terminal-inject" && !terminalTarget) {
    throw new CLIError(
      "TERMINAL_SESSION_REQUIRED",
      "No current terminal session was resolved. Run bridge start in the frontmost Codex terminal or pass --session.",
    );
  }
}

export function startDetachedBridge({
  attach,
  mode,
  accountId,
  threadId,
  cwd,
  terminalApp = null,
  terminalSession = null,
}) {
  const existing = inspectRuntimeState();
  if (existing?.pidAlive) {
    throw new CLIError("BRIDGE_ALREADY_RUNNING", "A bridge process is already running.", {
      runtime: existing,
    });
  }

  const runId = randomUUID();
  const logPath = resolveAgentBridgeLogPath(runId);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const cliPath = path.resolve(process.argv[1]);
  const startedAt = new Date().toISOString();
  const childArgs = [
    cliPath,
    "bridge",
    "run",
    "--attach",
    attach,
    "--mode",
    mode,
    "--account",
    accountId,
    "--thread-id",
    threadId,
    "--cwd",
    cwd,
    "--run-id",
    runId,
  ];

  if (terminalApp) {
    childArgs.push("--app", terminalApp);
  }

  if (terminalSession) {
    childArgs.push("--session", terminalSession);
  }

  const child = spawn(
    process.execPath,
    childArgs,
    {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );

  child.unref();
  fs.closeSync(logFd);

  const runtime = saveRuntimeState(runtimeSnapshot({
    runId,
    status: "starting",
    attach,
    mode,
    accountId,
    threadId,
    cwd,
    terminal: terminalSession
      ? {
          app: terminalApp,
          session: terminalSession,
        }
      : null,
    pid: child.pid,
    logPath,
    startedAt,
  }));

  appendEvent({
    type: "bridge.start.spawned",
    accountId,
    payload: {
      runId,
      pid: child.pid,
      mode,
      threadId,
      cwd,
      logPath,
      terminalApp,
      terminalSession,
    },
  });

  return runtime;
}

export async function runBridgeProcess({
  attach,
  mode = "terminal-inject",
  accountId,
  threadId,
  cwd,
  runId = randomUUID(),
  terminalApp = null,
  terminalSession = null,
}) {
  const account = loadAccountCredentials(accountId);
  if (!account?.configured || !account.token) {
    throw new CLIError("ACCOUNT_NOT_CONFIGURED", `Account ${accountId} is missing a token.`, {
      accountId,
    });
  }

  const startedAt = new Date().toISOString();
  const logPath = resolveAgentBridgeLogPath(runId);
  const sessionController = new CodexSessionController({
    threadId,
    cwd,
  });
  const terminalTarget = mode === "terminal-inject"
    ? await resolveCurrentTerminalTarget({
        app: terminalApp,
        session: terminalSession,
      })
    : null;
  const abortController = new AbortController();
  let stopReason = null;
  let appServerReady = false;
  let appServerError = null;

  const saveHeartbeat = () => saveRuntimeState(runtimeSnapshot({
    runId,
    status: abortController.signal.aborted ? "stopping" : "running",
    attach,
    mode,
    accountId,
    threadId,
    cwd,
    terminal: terminalTarget
      ? {
          app: terminalTarget.app,
          sessionId: terminalTarget.sessionId,
          handle: terminalTarget.handle,
          windowId: terminalTarget.windowId,
          tabIndex: terminalTarget.tabIndex,
          sessionIndex: terminalTarget.sessionIndex,
        }
      : null,
    appServer: {
      ready: appServerReady,
      error: appServerError,
    },
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
    try {
      await sessionController.start();
      appServerReady = true;
      appServerError = null;
    } catch (error) {
      appServerReady = false;
      appServerError = error instanceof Error ? error.message : String(error);
      appendEvent({
        type: "codex.app_server.unavailable",
        accountId,
        payload: {
          threadId,
          error: appServerError,
        },
      });
    }

    saveHeartbeat();

    appendEvent({
      type: "bridge.started",
      accountId,
      payload: {
        runId,
        pid: process.pid,
        mode,
        threadId,
        cwd,
        terminal: terminalTarget
          ? {
              app: terminalTarget.app,
              sessionId: terminalTarget.sessionId,
              handle: terminalTarget.handle,
            }
          : null,
        appServer: {
          ready: appServerReady,
          error: appServerError,
        },
      },
    });

    await runWeixinBridge({
      account,
      sessionController,
      appServerReady,
      mode,
      terminalTarget,
      abortSignal: abortController.signal,
    });

    saveRuntimeState(runtimeSnapshot({
      runId,
      status: "stopped",
      attach,
      mode,
      accountId,
      threadId,
      cwd,
      terminal: terminalTarget
        ? {
            app: terminalTarget.app,
            sessionId: terminalTarget.sessionId,
            handle: terminalTarget.handle,
            windowId: terminalTarget.windowId,
            tabIndex: terminalTarget.tabIndex,
            sessionIndex: terminalTarget.sessionIndex,
          }
        : null,
      appServer: {
        ready: appServerReady,
        error: appServerError,
      },
      pid: process.pid,
      logPath,
      startedAt,
      stoppedAt: new Date().toISOString(),
      stopReason: stopReason ?? "completed",
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    saveRuntimeState(runtimeSnapshot({
      runId,
      status: "error",
      attach,
      mode,
      accountId,
      threadId,
      cwd,
      terminal: terminalTarget
        ? {
            app: terminalTarget.app,
            sessionId: terminalTarget.sessionId,
            handle: terminalTarget.handle,
            windowId: terminalTarget.windowId,
            tabIndex: terminalTarget.tabIndex,
            sessionIndex: terminalTarget.sessionIndex,
          }
        : null,
      appServer: {
        ready: appServerReady,
        error: appServerError,
      },
      pid: process.pid,
      logPath,
      startedAt,
      stoppedAt: new Date().toISOString(),
      stopReason,
      lastError: message,
    }));
    appendEvent({
      type: "bridge.crashed",
      accountId,
      payload: {
        runId,
        threadId,
        mode,
        error: message,
      },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await sessionController.close();
  }
}

export function stopRunningBridge() {
  const runtime = loadRuntimeState();
  if (!runtime?.pid) {
    return {
      stopped: false,
      reason: "no_runtime",
      runtime: null,
    };
  }

  if (!isProcessAlive(runtime.pid)) {
    const next = saveRuntimeState({
      ...runtime,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      stopReason: "not_running",
    });
    return {
      stopped: false,
      reason: "not_running",
      runtime: next,
    };
  }

  process.kill(runtime.pid, "SIGTERM");
  const next = saveRuntimeState({
    ...runtime,
    status: "stopping",
    stopRequestedAt: new Date().toISOString(),
  });

  appendEvent({
    type: "bridge.stop.requested",
    accountId: runtime.accountId ?? null,
    payload: {
      runId: runtime.runId ?? null,
      pid: runtime.pid,
    },
  });

  return {
    stopped: true,
    reason: "signal_sent",
    runtime: next,
  };
}
