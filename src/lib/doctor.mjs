import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { listAccountIds, loadAccount } from "./accounts.mjs";
import { loadConfig } from "./config.mjs";
import {
  resolveAgentAgentsDir,
  resolveAgentConfigPath,
  resolveAgentConversationHistoryDir,
  resolveAgentEventsPath,
  resolveAgentRuntimePath,
  resolveAgentStateDir,
  resolveLegacyAgentRuntimePath,
  resolveLegacyAgentStateDir,
  resolveCodexStateDir,
  resolveCodexSessionIndexPath,
  resolveStateDir,
  resolveWeixinAccountsIndexPath,
} from "./paths.mjs";
import {
  inspectLegacyRuntimeState,
  inspectRuntimeState,
  listActiveRouterRuntimeStates,
} from "./runtime.mjs";
import { resolveCurrentCodexThreadTarget } from "./session-discovery.mjs";
import { resolveCurrentTerminalTarget } from "./terminal-control.mjs";

function makeCheck(id, status, message, details = null) {
  return { id, status, message, details };
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  if (major >= 22) {
    return makeCheck("node.version", "pass", `Node.js ${process.versions.node} is supported.`, {
      version: process.versions.node,
    });
  }
  return makeCheck("node.version", "fail", `Node.js ${process.versions.node} is too old; require >=22.`, {
    version: process.versions.node,
  });
}

function checkWritableDir(dirPath, id) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probePath = path.join(dirPath, ".doctor-write-test");
    fs.writeFileSync(probePath, "ok", "utf8");
    fs.unlinkSync(probePath);
    return makeCheck(id, "pass", `${dirPath} is writable.`, { path: dirPath });
  } catch (error) {
    return makeCheck(id, "fail", `${dirPath} is not writable.`, {
      path: dirPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function checkWhich(command, id) {
  const result = spawnSync("which", [command], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status === 0) {
    return makeCheck(id, "pass", `${command} is available.`, {
      command,
      path: result.stdout.trim(),
    });
  }
  return makeCheck(id, "warn", `${command} was not found in PATH.`, {
    command,
  });
}

function checkCodexRuntimeLog() {
  const logPath = path.join(resolveCodexStateDir(), "log", "codex-tui.log");
  try {
    if (!fs.existsSync(logPath)) {
      return makeCheck("codex.runtimeLog", "warn", "Codex TUI log was not found yet.", {
        path: logPath,
      });
    }

    const raw = fs.readFileSync(logPath, "utf8");
    const recent = raw.split("\n").slice(-400).join("\n");
    const migrationIssue = "migration 21 was previously applied but is missing in the resolved migrations";

    if (recent.includes(migrationIssue)) {
      return makeCheck(
        "codex.runtimeLog",
        "warn",
        "Codex runtime log shows a state migration mismatch; fresh threads may fail to materialize rollout history for bridge observation.",
        {
          path: logPath,
          issue: migrationIssue,
        },
      );
    }

    return makeCheck("codex.runtimeLog", "pass", "Codex runtime log did not show a recent rollout-state migration mismatch.", {
      path: logPath,
    });
  } catch (error) {
    return makeCheck("codex.runtimeLog", "warn", "Codex runtime log could not be inspected.", {
      path: logPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runDoctor() {
  const config = loadConfig();
  const accounts = listAccountIds();
  const selectedAccount = config.currentAccount ? loadAccount(config.currentAccount) : null;
  const accountIndexPath = resolveWeixinAccountsIndexPath();
  const currentThread = resolveCurrentCodexThreadTarget();
  const checks = [];

  checks.push(checkNodeVersion());
  checks.push(checkWritableDir(resolveStateDir(), "stateDir.writable"));
  checks.push(checkWritableDir(resolveAgentStateDir(), "agentStateDir.writable"));
  checks.push(checkWritableDir(resolveAgentAgentsDir(), "agentRegistryDir.writable"));
  checks.push(checkWritableDir(resolveAgentConversationHistoryDir(), "historyDir.writable"));
  checks.push(checkWhich("osascript", "osascript.binary"));

  if (fs.existsSync(accountIndexPath)) {
    checks.push(makeCheck("weixin.accountsIndex", "pass", "Existing WeChat account index found.", {
      path: accountIndexPath,
      count: accounts.length,
    }));
  } else {
    checks.push(makeCheck("weixin.accountsIndex", "warn", "No WeChat account index found yet.", {
      path: accountIndexPath,
    }));
  }

  if (selectedAccount) {
    checks.push(makeCheck("account.selected", "pass", `Selected account ${selectedAccount.id} is configured locally.`, {
      accountId: selectedAccount.id,
      configured: selectedAccount.configured,
    }));
  } else {
    checks.push(makeCheck("account.selected", "warn", "No selected account in weixin-agent config.", {
      configPath: resolveAgentConfigPath(),
    }));
  }

  checks.push(checkWhich("codex", "codex.binary"));
  checks.push(checkCodexRuntimeLog());
  checks.push(fs.existsSync(resolveCodexSessionIndexPath())
    ? makeCheck("codex.sessionIndex", "pass", "Codex session index is available.", {
        path: resolveCodexSessionIndexPath(),
      })
    : makeCheck("codex.sessionIndex", "warn", "Codex session index was not found yet.", {
        path: resolveCodexSessionIndexPath(),
      }));
  checks.push(currentThread
    ? makeCheck("codex.currentThread", "pass", `Current Codex thread resolved from ${currentThread.source}.`, currentThread)
    : makeCheck("codex.currentThread", "warn", "No current Codex thread was detected in this process.", {
        recommendation: "Run bridge start inside Codex or pass --thread-id explicitly.",
      }));

  try {
    const terminalTarget = await resolveCurrentTerminalTarget();
    checks.push(makeCheck(
      "terminal.currentSession",
      "pass",
      `Current terminal session resolved: ${terminalTarget.handle}.`,
      terminalTarget,
    ));
  } catch (error) {
    checks.push(makeCheck(
      "terminal.currentSession",
      "warn",
      "No current terminal session could be resolved for terminal injection.",
      {
        error: error instanceof Error ? error.message : String(error),
        recommendation: "Run bridge start in the frontmost Codex terminal or pass --session explicitly.",
      },
    ));
  }

  checks.push(makeCheck(
    "router.multiAgent",
    currentThread ? "pass" : "warn",
    "The primary flow is now one global router plus zero or more connected local AI terminal sessions.",
    {
      router: "weixin-agent start",
      connect: "weixin-agent connect --session <id|handle>",
      threadResolved: currentThread?.threadId ?? null,
    },
  ));
  checks.push(makeCheck("paths.runtime", "pass", "Runtime state path resolved.", {
    path: resolveAgentRuntimePath(),
  }));
  checks.push(makeCheck("paths.runtimeLegacy", "pass", "Legacy runtime path resolved for conflict detection.", {
    path: resolveLegacyAgentRuntimePath(),
    stateDir: resolveLegacyAgentStateDir(),
  }));
  checks.push(makeCheck("paths.events", "pass", "Events path resolved.", {
    path: resolveAgentEventsPath(),
  }));
  checks.push(makeCheck("paths.history", "pass", "Conversation history directory resolved.", {
    path: resolveAgentConversationHistoryDir(),
  }));

  const currentRuntime = inspectRuntimeState();
  const legacyRuntime = inspectLegacyRuntimeState();
  const activeRouters = listActiveRouterRuntimeStates();

  if (activeRouters.length > 1) {
    checks.push(makeCheck(
      "router.runtimeConflict",
      "fail",
      "Multiple router daemons are alive at the same time; duplicate WeChat replies can occur.",
      {
        runtimes: activeRouters,
      },
    ));
  } else if (legacyRuntime?.pidAlive && legacyRuntime.mode === "multi-agent-router") {
    checks.push(makeCheck(
      "router.runtimeConflict",
      "warn",
      "A legacy router from an older state directory is still alive. Stop it and keep only the ~/.weixin-agent router.",
      {
        legacyRuntime,
        currentRuntime,
      },
    ));
  } else if (legacyRuntime) {
    checks.push(makeCheck(
      "router.runtimeLegacy",
      legacyRuntime.pidAlive ? "warn" : "pass",
      legacyRuntime.pidAlive
        ? "A legacy runtime file exists and its process is still alive."
        : "Legacy runtime state was found but its process is not alive.",
      {
        legacyRuntime,
      },
    ));
  }

  const hasFailure = checks.some((entry) => entry.status === "fail");

  return {
    ok: !hasFailure,
    action: "doctor",
    checks,
    summary: {
      pass: checks.filter((entry) => entry.status === "pass").length,
      warn: checks.filter((entry) => entry.status === "warn").length,
      fail: checks.filter((entry) => entry.status === "fail").length,
    },
  };
}
