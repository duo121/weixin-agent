import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { loadAccountCredentials } from "./accounts.mjs";
import { appendEvent } from "./events.mjs";
import { CLIError } from "./errors.mjs";
import { resolveAgentBridgeLogPath } from "./paths.mjs";
import { inspectRuntimeState, isProcessAlive, saveRuntimeState } from "./runtime.mjs";
import { resolveCurrentTerminalTarget } from "./terminal-control.mjs";
import { runWeChatReplyBridge } from "./reply-bridge-runtime.mjs";

function runtimeSnapshot({
  runId,
  status,
  accountId,
  cwd,
  terminal = null,
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
    attach: "session-handle",
    mode: "ticket-reply",
    accountId,
    threadId: null,
    cwd,
    terminal,
    appServer: null,
    pid,
    logPath,
    startedAt,
    stoppedAt,
    stopReason,
    lastError,
    heartbeatAt,
  };
}

export function assertSessionBridgeStartable({
  accountId,
  terminalTarget = null,
}) {
  if (!accountId) {
    throw new CLIError("ACCOUNT_REQUIRED", "Select a WeChat account before starting the bridge.");
  }

  if (!terminalTarget) {
    throw new CLIError(
      "TERMINAL_SESSION_REQUIRED",
      "No terminal session was resolved. Run start in the target Codex terminal or pass --session.",
    );
  }
}

export function startDetachedSessionBridge({
  accountId,
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
    "__session-run",
    "--account",
    accountId,
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

  const child = spawn(process.execPath, childArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  fs.closeSync(logFd);

  const runtime = saveRuntimeState(runtimeSnapshot({
    runId,
    status: "starting",
    accountId,
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
      mode: "ticket-reply",
      cwd,
      logPath,
      terminalApp,
      terminalSession,
    },
  });

  return runtime;
}

export async function runSessionBridgeProcess({
  accountId,
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
  const terminalTarget = await resolveCurrentTerminalTarget({
    app: terminalApp,
    session: terminalSession,
  });
  const abortController = new AbortController();
  let stopReason = null;

  const saveHeartbeat = () => saveRuntimeState(runtimeSnapshot({
    runId,
    status: abortController.signal.aborted ? "stopping" : "running",
    accountId,
    cwd,
    terminal: {
      app: terminalTarget.app,
      sessionId: terminalTarget.sessionId,
      handle: terminalTarget.handle,
      windowId: terminalTarget.windowId,
      tabIndex: terminalTarget.tabIndex,
      sessionIndex: terminalTarget.sessionIndex,
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
    saveHeartbeat();

    appendEvent({
      type: "bridge.started",
      accountId,
      payload: {
        runId,
        pid: process.pid,
        mode: "ticket-reply",
        cwd,
        terminal: {
          app: terminalTarget.app,
          sessionId: terminalTarget.sessionId,
          handle: terminalTarget.handle,
        },
      },
    });

    await runWeChatReplyBridge({
      account,
      terminalTarget,
      abortSignal: abortController.signal,
    });

    saveRuntimeState(runtimeSnapshot({
      runId,
      status: "stopped",
      accountId,
      cwd,
      terminal: {
        app: terminalTarget.app,
        sessionId: terminalTarget.sessionId,
        handle: terminalTarget.handle,
        windowId: terminalTarget.windowId,
        tabIndex: terminalTarget.tabIndex,
        sessionIndex: terminalTarget.sessionIndex,
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
      accountId,
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
        mode: "ticket-reply",
        error: message,
        sessionHandle: terminalTarget?.handle ?? null,
      },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export function ensureSessionBridgeStartPlan({
  accountId,
  cwd,
  foreground = false,
  dryRun = false,
  terminalTarget = null,
}) {
  return {
    action: "start",
    attach: "session-handle",
    dryRun,
    mode: "ticket-reply",
    accountId,
    cwd,
    foreground,
    sources: ["local-terminal", "wechat"],
    controller: {
      type: "wechat-ticket-bridge",
      terminalTarget,
    },
    routing: {
      wechatInput: "inject wrapped task prompt into the target Codex terminal session",
      wechatReply: "Codex sends the final result back by calling `weixin-agent reply --ticket ...`",
    },
    notes: [
      terminalTarget
        ? `target terminal session resolved: ${terminalTarget.handle}`
        : "no terminal session was resolved; run start in the target Codex terminal or pass --session",
      accountId
        ? `selected account: ${accountId}`
        : "no account selected; run account login or pass --account",
      "the bridge daemon only listens for WeChat messages and injects prompts into the attached Codex session",
      "the final WeChat reply is sent only when Codex runs `weixin-agent reply --ticket ...`",
    ],
  };
}
