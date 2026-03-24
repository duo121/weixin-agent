#!/usr/bin/env node

import process from "node:process";

import { listAccounts, loadAccount, normalizeAccountId, removeAccount } from "./lib/accounts.mjs";
import {
  createAgentRecord,
  findAgentBySessionHandle,
  listAgents,
  normalizeAgentNameTemplate,
  normalizeExplicitAgentDisplayName,
} from "./lib/agents.mjs";
import {
  assertAgentConnectable,
  disconnectAgent,
  disconnectAgentByRecord,
  ensureAgentConnectPlan,
  renameConnectedAgent,
  renameSelfAgent,
  runAgentConnectionProcess,
  startDetachedAgentConnection,
} from "./lib/agent-service.mjs";
import {
  assertBridgeStartable,
  runBridgeProcess,
  startDetachedBridge,
  stopRunningBridge,
} from "./lib/bridge-service.mjs";
import { loadConfig, saveConfig, setConfigValue } from "./lib/config.mjs";
import { runDoctor } from "./lib/doctor.mjs";
import { CLIError, toErrorPayload } from "./lib/errors.mjs";
import { appendEvent, readEventLines } from "./lib/events.mjs";
import { parseOptions, printJson, readBoolOption } from "./lib/io.mjs";
import { loginAccount } from "./lib/login.mjs";
import {
  resolveAgentAgentsDir,
  resolveAgentConfigPath,
  resolveAgentRuntimePath,
  resolveLegacyAgentRuntimePath,
} from "./lib/paths.mjs";
import { sendTicketReply } from "./lib/reply-service.mjs";
import {
  assertRouterStartable,
  ensureRouterStartPlan,
  runRouterProcess,
  startDetachedRouter,
  stopRunningRouter,
} from "./lib/router-service.mjs";
import {
  buildBridgePlan,
  inspectKnownRuntimeStates,
  inspectLegacyRuntimeState,
  inspectRuntimeState,
  listActiveRouterRuntimeStates,
} from "./lib/runtime.mjs";
import { resolveCurrentCodexThreadTarget } from "./lib/session-discovery.mjs";
import { buildSpec } from "./lib/spec.mjs";
import { recoverAgentSession, spawnAgentSession } from "./lib/spawn-service.mjs";
import { resolveCurrentTerminalTarget } from "./lib/terminal-control.mjs";
import { buildStableAgentPrompt } from "./lib/ticket-prompt.mjs";
import { transferTicket } from "./lib/transfer-service.mjs";

function printHelp() {
  process.stdout.write(`weixin-agent

Usage:
  weixin-agent spec [--compact]
  weixin-agent doctor [--compact]
  weixin-agent status [--compact]

  weixin-agent account list [--compact]
  weixin-agent account show [--account <id>] [--compact]
  weixin-agent account login [--base-url <url>] [--timeout-ms <n>] [--print-only] [--open-browser] [--no-open-browser] [--compact]
  weixin-agent account use <id> [--compact]
  weixin-agent account remove <id> [--compact]

  weixin-agent config get [<key>] [--compact]
  weixin-agent config set <key> <value> [--compact]

  weixin-agent events tail [--lines <n>] [--compact]

  weixin-agent start [--account <id>] [--cwd <path>] [--foreground] [--dry-run]
  weixin-agent stop [--compact]
  weixin-agent spawn [codex|claude|custom] --name <displayName> [--app iterm2|terminal] [--command <cmd>] [--cwd <path>] [--compact]
  weixin-agent recover --name <displayName> [--app iterm2|terminal] [--command <cmd>] [--cwd <path>] [--compact]

  weixin-agent connect [--session <id|handle>] [--app iterm2|terminal] [--kind codex|claude|custom] --name <displayName> [--cwd <path>] [--foreground] [--dry-run]
  weixin-agent disconnect [--agent <id> | --session <id|handle> | --name <displayName>] [--force] [--compact]
  weixin-agent rename template <template-with-{n}> [--compact]
  weixin-agent rename agent [--agent <id> | --session <id|handle> | --current-name <displayName>] --to <displayName> [--compact]
  weixin-agent agents list [--all] [--compact]

  weixin-agent self status [--compact]
  weixin-agent self prompt-stable [--json] [--compact]
  weixin-agent self rename --name <displayName> [--compact]
  weixin-agent self disconnect [--force] [--compact]

  weixin-agent reply --ticket <id> [--message <text> | --stdin] [--media <path|url> | --image <path|url>] [--compact]
  weixin-agent transfer --ticket <id> --to <displayName[,displayName...]> [--message <text> | --stdin] [--compact]

  weixin-agent bridge status [--compact]
  weixin-agent bridge start [--attach current-codex] [--mode terminal-inject|direct-thread] [--app iterm2|terminal] [--session <id|handle>] [--account <id>] [--thread-id <id>] [--cwd <path>] [--foreground] [--dry-run]
  weixin-agent bridge stop [--compact]

Notes:
  - start only launches the global router daemon, even if there are zero connected agents.
  - When zero live agents are available, the router can auto-spawn one default agent terminal before routing the inbound WeChat message. If no explicit @name is provided, that first agent defaults to 元宝一号.
  - spawn opens a new terminal session, starts the requested AI CLI command, and connects it into the running router. Later agents still require an explicit --name.
  - recover --name reopens a previously known offline agent by the same display name when recovery information is available.
  - connect --session attaches one Codex / Claude / local AI terminal session into the running router.
  - connect requires --name <displayName>; names are not auto-generated by the CLI.
  - rename template updates the stored naming template in ~/.weixin-agent/config.json and accepts values like "豆包{n}号".
  - rename agent and self rename also require explicit full display names; duplicate live names are rejected.
  - If a message starts with @agent-name, router uses strict routing; otherwise it falls back to the recent agent used by that WeChat conversation, then to the latest connected live agent.
  - transfer lets the current agent hand off one pending ticket to one or more other connected agents.
  - self prompt-stable prints the mostly fixed routing/delegation prompt for the current connected agent session; per-ticket prompt injection only carries dynamic ticket data, user message, and session context.
  - reply --ticket is still the explicit path for the terminal agent to send the final result back to WeChat, and replies are auto-prefixed with the agent identity.
  - reply supports --media <path|url> for official WeChat CDN upload and delivery of image / video / file attachments. --image is a compatibility alias.
  - All WeChat history is appended as account-level JSONL under ~/.weixin-agent/history/<account>.jsonl, and each line carries its own conversationId.
  - Use "weixin-agent spec" for the machine-readable contract.
`);
}

function requirePositional(positionals, index, label) {
  const value = positionals[index];
  if (!value) {
    throw new CLIError("MISSING_ARGUMENT", `${label} is required.`, { label });
  }
  return value;
}

function resolveSelectedAccount(config, requestedAccountId) {
  const effective = requestedAccountId ?? config.currentAccount ?? null;
  if (!effective) {
    return null;
  }
  return loadAccount(effective);
}

async function resolveOptionalCurrentTerminalTarget() {
  try {
    return await resolveCurrentTerminalTarget();
  } catch {
    return null;
  }
}

async function buildStatusPayload() {
  const config = loadConfig();
  const selectedAccount = resolveSelectedAccount(config, null);
  const routerRuntime = inspectRuntimeState();
  const legacyRouterRuntime = inspectLegacyRuntimeState();
  const knownRuntimes = inspectKnownRuntimeStates();
  const activeRouterRuntimes = listActiveRouterRuntimeStates();
  const currentCodexThread = resolveCurrentCodexThreadTarget();
  const currentTerminalTarget = await resolveOptionalCurrentTerminalTarget();
  const currentAgent = currentTerminalTarget
    ? findAgentBySessionHandle(currentTerminalTarget.handle, { onlyLive: true })
    : null;
  const connectedAgents = listAgents({ onlyLive: true });
  const allAgents = listAgents();

  return {
    ok: true,
    action: "status",
    configPath: resolveAgentConfigPath(),
    runtimePath: resolveAgentRuntimePath(),
    legacyRuntimePath: resolveLegacyAgentRuntimePath(),
    agentsDir: resolveAgentAgentsDir(),
    config,
    selectedAccount,
    currentCodexThread,
    currentTerminalTarget,
    currentAgent,
    routerRuntime,
    legacyRouterRuntime,
    knownRuntimes,
    activeRouterRuntimes,
    connectedAgents,
    agents: allAgents,
    summary: {
      activeRouterRuntimes: activeRouterRuntimes.length,
      connectedAgents: connectedAgents.length,
      totalAgents: allAgents.length,
    },
  };
}

function handleSpec(tokens) {
  const { options } = parseOptions(tokens);
  printJson(buildSpec(), readBoolOption(options, "compact"));
}

async function handleDoctor(tokens) {
  const { options } = parseOptions(tokens);
  printJson(await runDoctor(), readBoolOption(options, "compact"));
}

async function handleStatus(tokens) {
  const { options } = parseOptions(tokens);
  printJson(await buildStatusPayload(), readBoolOption(options, "compact"));
}

async function handleAccount(tokens) {
  const subcommand = tokens[0];
  const parsed = parseOptions(tokens.slice(1));
  const compact = readBoolOption(parsed.options, "compact");
  const config = loadConfig();

  switch (subcommand) {
    case "list": {
      const accounts = listAccounts().map((account) => ({
        ...account,
        selected: config.currentAccount === account.id,
      }));
      printJson({
        ok: true,
        action: "account.list",
        accounts,
      }, compact);
      return;
    }

    case "show": {
      const requested = parsed.options.account ?? config.currentAccount;
      if (!requested) {
        throw new CLIError("ACCOUNT_REQUIRED", "No account was specified and no default account is selected.");
      }
      const account = loadAccount(requested);
      if (!account) {
        throw new CLIError("ACCOUNT_NOT_FOUND", `Account ${requested} was not found.`, {
          accountId: requested,
        });
      }
      printJson({
        ok: true,
        action: "account.show",
        account: {
          ...account,
          selected: config.currentAccount === account.id,
        },
      }, compact);
      return;
    }

    case "use": {
      const accountId = normalizeAccountId(requirePositional(parsed.positionals, 0, "account id"));
      const account = loadAccount(accountId);
      if (!account) {
        throw new CLIError("ACCOUNT_NOT_FOUND", `Account ${accountId} was not found.`, {
          accountId,
        });
      }
      const nextConfig = saveConfig({
        ...config,
        currentAccount: accountId,
      });
      appendEvent({
        type: "account.selected",
        accountId,
        payload: {
          source: "account.use",
        },
      });
      printJson({
        ok: true,
        action: "account.use",
        selectedAccountId: accountId,
        config: nextConfig,
      }, compact);
      return;
    }

    case "remove": {
      const accountId = normalizeAccountId(requirePositional(parsed.positionals, 0, "account id"));
      const result = removeAccount(accountId);
      const nextConfig = config.currentAccount === accountId
        ? saveConfig({
            ...config,
            currentAccount: null,
          })
        : config;
      appendEvent({
        type: "account.removed",
        accountId,
        payload: {
          removed: result.removed,
        },
      });
      printJson({
        ok: true,
        action: "account.remove",
        ...result,
        config: nextConfig,
      }, compact);
      return;
    }

    case "login": {
      const result = await loginAccount({
        baseUrl: typeof parsed.options["base-url"] === "string" ? parsed.options["base-url"] : undefined,
        timeoutMs: typeof parsed.options["timeout-ms"] === "string" ? Number(parsed.options["timeout-ms"]) : undefined,
        printOnly: readBoolOption(parsed.options, "print-only"),
        openBrowser:
          readBoolOption(parsed.options, "open-browser") &&
          !readBoolOption(parsed.options, "no-open-browser"),
      });

      const nextConfig = result.accountId
        ? saveConfig({
            ...config,
            currentAccount: result.accountId,
          })
        : config;

      printJson({
        ...result,
        config: nextConfig,
      }, compact);
      return;
    }

    default:
      throw new CLIError("UNKNOWN_ACCOUNT_COMMAND", `Unknown account subcommand: ${String(subcommand ?? "")}`);
  }
}

function handleConfig(tokens) {
  const subcommand = tokens[0];
  const parsed = parseOptions(tokens.slice(1));
  const compact = readBoolOption(parsed.options, "compact");

  switch (subcommand) {
    case "get": {
      const config = loadConfig();
      const key = parsed.positionals[0];
      if (!key) {
        printJson({
          ok: true,
          action: "config.get",
          config,
        }, compact);
        return;
      }
      printJson({
        ok: true,
        action: "config.get",
        key,
        value: config[key] ?? null,
      }, compact);
      return;
    }

    case "set": {
      const key = requirePositional(parsed.positionals, 0, "config key");
      const value = requirePositional(parsed.positionals, 1, "config value");
      const config = setConfigValue(key, value);
      appendEvent({
        type: "config.updated",
        accountId: config.currentAccount ?? null,
        payload: {
          key,
          value,
        },
      });
      printJson({
        ok: true,
        action: "config.set",
        updated: {
          key,
          value,
        },
        config,
      }, compact);
      return;
    }

    default:
      throw new CLIError("UNKNOWN_CONFIG_COMMAND", `Unknown config subcommand: ${String(subcommand ?? "")}`);
  }
}

function handleEvents(tokens) {
  const subcommand = tokens[0];
  const parsed = parseOptions(tokens.slice(1));
  const compact = readBoolOption(parsed.options, "compact");

  switch (subcommand) {
    case "tail": {
      const lines = typeof parsed.options.lines === "string" ? Number(parsed.options.lines) : 50;
      printJson({
        ok: true,
        action: "events.tail",
        ...readEventLines(Number.isFinite(lines) ? lines : 50),
      }, compact);
      return;
    }

    default:
      throw new CLIError("UNKNOWN_EVENTS_COMMAND", `Unknown events subcommand: ${String(subcommand ?? "")}`);
  }
}

async function handleBridge(tokens) {
  const subcommand = tokens[0];
  const parsed = parseOptions(tokens.slice(1));
  const compact = readBoolOption(parsed.options, "compact");
  const config = loadConfig();

  switch (subcommand) {
    case "status": {
      const currentCodexThread = resolveCurrentCodexThreadTarget({
        threadId: typeof parsed.options["thread-id"] === "string" ? parsed.options["thread-id"] : null,
      });
      const mode = parsed.options.mode ?? config.defaultBridgeMode ?? "terminal-inject";
      let currentTerminalTarget = null;

      if (mode === "terminal-inject") {
        try {
          currentTerminalTarget = await resolveCurrentTerminalTarget({
            app: typeof parsed.options.app === "string" ? parsed.options.app : null,
            session: typeof parsed.options.session === "string" ? parsed.options.session : null,
          });
        } catch {
          currentTerminalTarget = null;
        }
      }

      printJson({
        ok: true,
        action: "bridge.status",
        defaultAttach: config.defaultAttach,
        defaultMode: config.defaultBridgeMode ?? "terminal-inject",
        selectedAccount: config.currentAccount,
        mode,
        currentCodexThread,
        currentTerminalTarget,
        runtime: inspectRuntimeState(),
      }, compact);
      return;
    }

    case "start": {
      const attach = parsed.options.attach ?? config.defaultAttach ?? "current-codex";
      const mode = parsed.options.mode ?? config.defaultBridgeMode ?? "terminal-inject";
      const accountId = parsed.options.account ?? config.currentAccount ?? null;
      const cwd = typeof parsed.options.cwd === "string" ? parsed.options.cwd : process.cwd();
      const currentCodexThread = resolveCurrentCodexThreadTarget({
        threadId: typeof parsed.options["thread-id"] === "string" ? parsed.options["thread-id"] : null,
      });
      const terminalTarget = mode === "terminal-inject"
        ? await resolveCurrentTerminalTarget({
            app: typeof parsed.options.app === "string" ? parsed.options.app : null,
            session: typeof parsed.options.session === "string" ? parsed.options.session : null,
          })
        : null;
      const plan = buildBridgePlan({
        attach,
        accountId,
        cwd,
        passthrough: parsed.passthrough,
        dryRun: readBoolOption(parsed.options, "dry-run"),
        mode,
        threadId: currentCodexThread?.threadId ?? null,
        threadSource: currentCodexThread?.source ?? null,
        foreground: readBoolOption(parsed.options, "foreground"),
        terminalTarget,
      });

      if (readBoolOption(parsed.options, "dry-run")) {
        appendEvent({
          type: "bridge.plan",
          accountId,
          payload: plan,
        });
        printJson({
          ok: true,
          ...plan,
          status: "planned",
        }, compact);
        return;
      }

      assertBridgeStartable({
        attach,
        accountId,
        threadId: currentCodexThread?.threadId ?? null,
        mode,
        terminalTarget,
      });

      if (readBoolOption(parsed.options, "foreground")) {
        appendEvent({
          type: "bridge.start.foreground",
          accountId,
          payload: plan,
        });
        printJson({
          ok: true,
          action: "bridge.start",
          status: "foreground_running",
          plan,
        }, compact);
        return runBridgeProcess({
          attach,
          mode,
          accountId,
          threadId: currentCodexThread.threadId,
          cwd,
          terminalApp: terminalTarget?.app ?? null,
          terminalSession: terminalTarget?.handle ?? null,
        });
      }

      const runtime = startDetachedBridge({
        attach,
        mode,
        accountId,
        threadId: currentCodexThread.threadId,
        cwd,
        terminalApp: terminalTarget?.app ?? null,
        terminalSession: terminalTarget?.handle ?? null,
      });

      printJson({
        ok: true,
        action: "bridge.start",
        status: "spawned",
        plan,
        runtime,
      }, compact);
      return;
    }

    case "stop": {
      const result = stopRunningBridge();
      printJson({
        ok: true,
        action: "bridge.stop",
        ...result,
      }, compact);
      return;
    }

    case "run": {
      const attach = parsed.options.attach ?? config.defaultAttach ?? "current-codex";
      const mode = parsed.options.mode ?? config.defaultBridgeMode ?? "terminal-inject";
      const accountId = parsed.options.account ?? config.currentAccount ?? null;
      const cwd = typeof parsed.options.cwd === "string" ? parsed.options.cwd : process.cwd();
      const threadId = typeof parsed.options["thread-id"] === "string" ? parsed.options["thread-id"] : null;
      const runId = typeof parsed.options["run-id"] === "string" ? parsed.options["run-id"] : undefined;
      const terminalTarget = mode === "terminal-inject"
        ? await resolveCurrentTerminalTarget({
            app: typeof parsed.options.app === "string" ? parsed.options.app : null,
            session: typeof parsed.options.session === "string" ? parsed.options.session : null,
          })
        : null;

      assertBridgeStartable({
        attach,
        accountId,
        threadId,
        mode,
        terminalTarget,
      });

      return runBridgeProcess({
        attach,
        mode,
        accountId,
        threadId,
        cwd,
        runId,
        terminalApp: terminalTarget?.app ?? null,
        terminalSession: terminalTarget?.handle ?? null,
      });
    }

    default:
      throw new CLIError("UNKNOWN_BRIDGE_COMMAND", `Unknown bridge subcommand: ${String(subcommand ?? "")}`);
  }
}

async function readStdinText() {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

async function handleStart(tokens) {
  const parsed = parseOptions(tokens);
  const compact = readBoolOption(parsed.options, "compact");
  const config = loadConfig();
  const accountId = parsed.options.account ?? config.currentAccount ?? null;
  const cwd = typeof parsed.options.cwd === "string" ? parsed.options.cwd : process.cwd();

  if (parsed.options.session) {
    throw new CLIError("START_DOES_NOT_ACCEPT_SESSION", "start no longer accepts --session. Use `weixin-agent connect --session ...` to attach an agent terminal session.");
  }

  const plan = ensureRouterStartPlan({
    accountId,
    cwd,
    foreground: readBoolOption(parsed.options, "foreground"),
    dryRun: readBoolOption(parsed.options, "dry-run"),
  });

  if (readBoolOption(parsed.options, "dry-run")) {
    appendEvent({
      type: "router.plan",
      accountId,
      payload: plan,
    });
    printJson({
      ok: true,
      ...plan,
      status: "planned",
    }, compact);
    return;
  }

  assertRouterStartable({ accountId });

  if (readBoolOption(parsed.options, "foreground")) {
    appendEvent({
      type: "router.start.foreground",
      accountId,
      payload: plan,
    });
    printJson({
      ok: true,
      action: "start",
      status: "foreground_running",
      plan,
    }, compact);
    return runRouterProcess({
      accountId,
      cwd,
    });
  }

  const runtime = startDetachedRouter({
    accountId,
    cwd,
  });

  printJson({
    ok: true,
    action: "start",
    status: "spawned",
    plan,
    runtime,
  }, compact);
}

async function handleConnect(tokens) {
  const parsed = parseOptions(tokens);
  const compact = readBoolOption(parsed.options, "compact");
  const cwd = typeof parsed.options.cwd === "string" ? parsed.options.cwd : process.cwd();
  if (typeof parsed.options.name !== "string" || !parsed.options.name.trim()) {
    throw new CLIError("AGENT_NAME_REQUIRED", "connect requires --name <displayName>. Names are never auto-generated.");
  }
  const requestedName = normalizeExplicitAgentDisplayName(parsed.options.name);
  const terminalTarget = await resolveCurrentTerminalTarget({
    app: typeof parsed.options.app === "string" ? parsed.options.app : null,
    session: typeof parsed.options.session === "string" ? parsed.options.session : null,
  });
  const kind = typeof parsed.options.kind === "string" ? parsed.options.kind : "codex";
  const plan = ensureAgentConnectPlan({
    terminalTarget,
    requestedName,
    kind,
    foreground: readBoolOption(parsed.options, "foreground"),
    dryRun: readBoolOption(parsed.options, "dry-run"),
  });

  if (readBoolOption(parsed.options, "dry-run")) {
    printJson({
      ok: true,
      ...plan,
      status: "planned",
    }, compact);
    return;
  }

  assertAgentConnectable({
    terminalTarget,
  });

  if (readBoolOption(parsed.options, "foreground")) {
    const agent = createAgentRecord({
      terminalTarget,
      requestedName,
      kind,
      cwd,
      pid: process.pid,
    });
    printJson({
      ok: true,
      action: "connect",
      status: "foreground_running",
      plan,
      agent,
    }, compact);
    return runAgentConnectionProcess({
      agentId: agent.id,
      cwd,
      terminalApp: terminalTarget.app,
      terminalSession: terminalTarget.handle,
    });
  }

  const agent = startDetachedAgentConnection({
    terminalTarget,
    requestedName,
    kind,
    cwd,
  });

  printJson({
    ok: true,
    action: "connect",
    status: "spawned",
    plan,
    agent,
  }, compact);
}

async function handleSpawn(tokens) {
  const parsed = parseOptions(tokens);
  const compact = readBoolOption(parsed.options, "compact");
  const requestedName = typeof parsed.options.name === "string"
    ? normalizeExplicitAgentDisplayName(parsed.options.name)
    : "";
  if (!requestedName) {
    throw new CLIError("AGENT_NAME_REQUIRED", "spawn requires --name <displayName>.");
  }

  const kind = parsed.positionals[0] || parsed.options.kind || "codex";
  const result = await spawnAgentSession({
    requestedName,
    kind,
    app: typeof parsed.options.app === "string" ? parsed.options.app : null,
    command: typeof parsed.options.command === "string" ? parsed.options.command : null,
    cwd: typeof parsed.options.cwd === "string" ? parsed.options.cwd : process.cwd(),
    autoNameAllowed: false,
    reason: "cli.spawn",
  });

  printJson(result, compact);
}

async function handleRecover(tokens) {
  const parsed = parseOptions(tokens);
  const compact = readBoolOption(parsed.options, "compact");
  const requestedName = typeof parsed.options.name === "string"
    ? normalizeExplicitAgentDisplayName(parsed.options.name)
    : "";
  if (!requestedName) {
    throw new CLIError("AGENT_NAME_REQUIRED", "recover requires --name <displayName>.");
  }

  const result = await recoverAgentSession({
    displayName: requestedName,
    app: typeof parsed.options.app === "string" ? parsed.options.app : null,
    command: typeof parsed.options.command === "string" ? parsed.options.command : null,
    cwd: typeof parsed.options.cwd === "string" ? parsed.options.cwd : null,
  });

  printJson(result, compact);
}

async function handleDisconnect(tokens) {
  const parsed = parseOptions(tokens);
  const compact = readBoolOption(parsed.options, "compact");
  const force = readBoolOption(parsed.options, "force");
  const requestedAgentId = typeof parsed.options.agent === "string" ? parsed.options.agent.trim() : null;
  const requestedSession = typeof parsed.options.session === "string" ? parsed.options.session.trim() : null;
  const requestedName = typeof parsed.options.name === "string" ? parsed.options.name.trim() : null;

  let result = null;
  if (!requestedAgentId && !requestedSession && !requestedName) {
    const terminalTarget = await resolveCurrentTerminalTarget();
    const agent = findAgentBySessionHandle(terminalTarget.handle, { onlyLive: true });
    result = disconnectAgentByRecord(agent, { force });
  } else {
    result = disconnectAgent({
      agentId: requestedAgentId,
      sessionHandle: requestedSession,
      displayName: requestedName,
      force,
    });
  }

  printJson({
    ok: true,
    action: "disconnect",
    agent: result,
  }, compact);
}

async function handleRename(tokens) {
  const subcommand = tokens[0];
  const parsed = parseOptions(tokens.slice(1));
  const compact = readBoolOption(parsed.options, "compact");

  switch (subcommand) {
    case "template": {
      const rawTemplate = requirePositional(parsed.positionals, 0, "template");
      const normalizedTemplate = normalizeAgentNameTemplate(rawTemplate);
      const nextConfig = saveConfig({
        ...loadConfig(),
        agentNameTemplate: normalizedTemplate,
      });

      appendEvent({
        type: "config.updated",
        accountId: nextConfig.currentAccount ?? null,
        payload: {
          key: "agentNameTemplate",
          value: normalizedTemplate,
        },
      });

      printJson({
        ok: true,
        action: "rename.template",
        template: normalizedTemplate,
        config: nextConfig,
      }, compact);
      return;
    }

    case "agent": {
      const requestedName = typeof parsed.options.to === "string" ? normalizeExplicitAgentDisplayName(parsed.options.to) : "";
      if (!requestedName) {
        throw new CLIError("AGENT_NAME_REQUIRED", "rename agent requires --to <displayName>.");
      }

      let agent = null;
      if (typeof parsed.options.agent === "string") {
        agent = renameConnectedAgent({
          agentId: parsed.options.agent.trim(),
          requestedName,
        });
      } else if (typeof parsed.options.session === "string") {
        agent = renameConnectedAgent({
          sessionHandle: parsed.options.session.trim(),
          requestedName,
        });
      } else if (typeof parsed.options["current-name"] === "string") {
        agent = renameConnectedAgent({
          displayName: parsed.options["current-name"].trim(),
          requestedName,
        });
      } else {
        const terminalTarget = await resolveCurrentTerminalTarget();
        agent = renameConnectedAgent({
          sessionHandle: terminalTarget.handle,
          requestedName,
        });
      }

      printJson({
        ok: true,
        action: "rename.agent",
        agent,
      }, compact);
      return;
    }

    default:
      throw new CLIError("UNKNOWN_RENAME_COMMAND", `Unknown rename subcommand: ${String(subcommand ?? "")}`);
  }
}

function handleAgents(tokens) {
  const subcommand = tokens[0];
  const parsed = parseOptions(tokens.slice(1));
  const compact = readBoolOption(parsed.options, "compact");

  switch (subcommand) {
    case "list": {
      const includeAll = readBoolOption(parsed.options, "all");
      const agents = includeAll
        ? listAgents()
        : listAgents({ onlyLive: true });
      printJson({
        ok: true,
        action: "agents.list",
        includeAll,
        agents,
        summary: {
          count: agents.length,
        },
      }, compact);
      return;
    }

    default:
      throw new CLIError("UNKNOWN_AGENTS_COMMAND", `Unknown agents subcommand: ${String(subcommand ?? "")}`);
  }
}

async function handleSelf(tokens) {
  const subcommand = tokens[0];
  const parsed = parseOptions(tokens.slice(1));
  const compact = readBoolOption(parsed.options, "compact");
  const terminalTarget = await resolveCurrentTerminalTarget({
    app: typeof parsed.options.app === "string" ? parsed.options.app : null,
    session: typeof parsed.options.session === "string" ? parsed.options.session : null,
  });
  const currentAgent = findAgentBySessionHandle(terminalTarget.handle, { onlyLive: true });

  switch (subcommand) {
    case "status": {
      printJson({
        ok: true,
        action: "self.status",
        terminalTarget,
        agent: currentAgent,
      }, compact);
      return;
    }

    case "prompt-stable": {
      if (!currentAgent) {
        throw new CLIError("AGENT_NOT_CONNECTED", "The current terminal session is not connected as an online agent.", {
          sessionHandle: terminalTarget?.handle ?? null,
        });
      }

      const promptText = buildStableAgentPrompt({
        agentName: currentAgent.displayName,
      });

      if (readBoolOption(parsed.options, "json")) {
        printJson({
          ok: true,
          action: "self.prompt-stable",
          terminalTarget,
          agent: currentAgent,
          promptText,
        }, compact);
        return;
      }

      process.stdout.write(`${promptText}\n`);
      return;
    }

    case "rename": {
      const requestedName = typeof parsed.options.name === "string" ? normalizeExplicitAgentDisplayName(parsed.options.name) : "";
      if (!requestedName) {
        throw new CLIError("AGENT_NAME_REQUIRED", "self rename requires --name <displayName>.");
      }
      const agent = renameSelfAgent({
        terminalTarget,
        requestedName,
      });
      printJson({
        ok: true,
        action: "self.rename",
        terminalTarget,
        agent,
      }, compact);
      return;
    }

    case "disconnect": {
      const agent = disconnectAgentByRecord(currentAgent, {
        force: readBoolOption(parsed.options, "force"),
      });
      printJson({
        ok: true,
        action: "self.disconnect",
        terminalTarget,
        agent,
      }, compact);
      return;
    }

    default:
      throw new CLIError("UNKNOWN_SELF_COMMAND", `Unknown self subcommand: ${String(subcommand ?? "")}`);
  }
}

async function handleReply(tokens) {
  const parsed = parseOptions(tokens);
  const compact = readBoolOption(parsed.options, "compact");
  const ticketId = typeof parsed.options.ticket === "string" ? parsed.options.ticket.trim() : "";
  if (!ticketId) {
    throw new CLIError("TICKET_REQUIRED", "reply requires --ticket <id>.");
  }

  const hasMessage = typeof parsed.options.message === "string";
  const useStdin = readBoolOption(parsed.options, "stdin");
  if (hasMessage && useStdin) {
    throw new CLIError("REPLY_INPUT_CONFLICT", "Use at most one of --message <text> or --stdin.");
  }

  const mediaInput = typeof parsed.options.media === "string"
    ? parsed.options.media
    : (typeof parsed.options.image === "string" ? parsed.options.image : null);
  if (typeof parsed.options.media === "string" && typeof parsed.options.image === "string") {
    throw new CLIError("REPLY_MEDIA_CONFLICT", "Use at most one of --media <path|url> or --image <path|url>.");
  }

  if (!hasMessage && !useStdin && !mediaInput) {
    throw new CLIError("REPLY_INPUT_REQUIRED", "reply requires text (--message/--stdin), media (--media/--image), or both.");
  }

  const text = hasMessage
    ? parsed.options.message
    : (useStdin ? await readStdinText() : "");

  const result = await sendTicketReply({
    ticketId,
    text,
    mediaInput,
  });

  printJson(result, compact);
}

async function handleTransfer(tokens) {
  const parsed = parseOptions(tokens);
  const compact = readBoolOption(parsed.options, "compact");
  const ticketId = typeof parsed.options.ticket === "string" ? parsed.options.ticket.trim() : "";
  if (!ticketId) {
    throw new CLIError("TICKET_REQUIRED", "transfer requires --ticket <id>.");
  }

  const to = typeof parsed.options.to === "string" ? parsed.options.to.trim() : "";
  if (!to) {
    throw new CLIError("TRANSFER_TARGET_REQUIRED", "transfer requires --to <displayName[,displayName...]>.");
  }

  const hasMessage = typeof parsed.options.message === "string";
  const useStdin = readBoolOption(parsed.options, "stdin");
  if (hasMessage && useStdin) {
    throw new CLIError("TRANSFER_INPUT_CONFLICT", "Use at most one of --message <text> or --stdin.");
  }

  const textOverride = hasMessage
    ? parsed.options.message
    : (useStdin ? await readStdinText() : null);

  const terminalTarget = await resolveCurrentTerminalTarget({
    app: typeof parsed.options.app === "string" ? parsed.options.app : null,
    session: typeof parsed.options.session === "string" ? parsed.options.session : null,
  });

  const result = await transferTicket({
    ticketId,
    targetNames: to,
    terminalTarget,
    textOverride,
  });

  printJson(result, compact);
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    return;
  }

  if (argv[0] === "--version") {
    printJson({
      ok: true,
      name: "weixin-agent",
      version: buildSpec().cli.version,
    }, true);
    return;
  }

  switch (argv[0]) {
    case "spec":
      handleSpec(argv.slice(1));
      return;
    case "doctor":
      await handleDoctor(argv.slice(1));
      return;
    case "status":
      await handleStatus(argv.slice(1));
      return;
    case "account":
      await handleAccount(argv.slice(1));
      return;
    case "config":
      handleConfig(argv.slice(1));
      return;
    case "events":
      handleEvents(argv.slice(1));
      return;
    case "start":
      await handleStart(argv.slice(1));
      return;
    case "stop": {
      const { options } = parseOptions(argv.slice(1));
      printJson({
        ok: true,
        action: "stop",
        ...stopRunningRouter(),
      }, readBoolOption(options, "compact"));
      return;
    }
    case "connect":
      await handleConnect(argv.slice(1));
      return;
    case "spawn":
      await handleSpawn(argv.slice(1));
      return;
    case "recover":
      await handleRecover(argv.slice(1));
      return;
    case "disconnect":
      await handleDisconnect(argv.slice(1));
      return;
    case "rename":
      await handleRename(argv.slice(1));
      return;
    case "agents":
      handleAgents(argv.slice(1));
      return;
    case "self":
      await handleSelf(argv.slice(1));
      return;
    case "reply":
      await handleReply(argv.slice(1));
      return;
    case "transfer":
      await handleTransfer(argv.slice(1));
      return;
    case "__router-run": {
      const parsed = parseOptions(argv.slice(1));
      return runRouterProcess({
        accountId: parsed.options.account ?? loadConfig().currentAccount ?? null,
        cwd: typeof parsed.options.cwd === "string" ? parsed.options.cwd : process.cwd(),
        runId: typeof parsed.options["run-id"] === "string" ? parsed.options["run-id"] : undefined,
      });
    }
    case "__agent-run": {
      const parsed = parseOptions(argv.slice(1));
      const agentId = typeof parsed.options["agent-id"] === "string" ? parsed.options["agent-id"] : null;
      if (!agentId) {
        throw new CLIError("AGENT_ID_REQUIRED", "__agent-run requires --agent-id <id>.");
      }
      return runAgentConnectionProcess({
        agentId,
        cwd: typeof parsed.options.cwd === "string" ? parsed.options.cwd : process.cwd(),
        terminalApp: typeof parsed.options.app === "string" ? parsed.options.app : null,
        terminalSession: typeof parsed.options.session === "string" ? parsed.options.session : null,
      });
    }
    case "bridge":
      await handleBridge(argv.slice(1));
      return;
    default:
      throw new CLIError("UNKNOWN_COMMAND", `Unknown command: ${argv[0]}`, {
        command: argv[0],
      });
  }
}

main(process.argv.slice(2)).catch((error) => {
  printJson(toErrorPayload(error), true);
  process.exit(error instanceof CLIError ? error.exitCode : 1);
});
