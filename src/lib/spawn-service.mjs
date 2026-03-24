import process from "node:process";

import {
  findAgentByDisplayName,
  findLatestAgentByDisplayName,
  listAgents,
  loadAgent,
  normalizeAgentKind,
  normalizeExplicitAgentDisplayName,
} from "./agents.mjs";
import { startDetachedAgentConnection } from "./agent-service.mjs";
import { loadConfig } from "./config.mjs";
import { appendEvent } from "./events.mjs";
import { CLIError } from "./errors.mjs";
import { inspectRuntimeState } from "./runtime.mjs";
import { getTerminalSnapshot, launchTerminalSession } from "./terminal-control.mjs";

const DEFAULT_BOOTSTRAP_AGENT_NAME = "元宝一号";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function readNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildLaunchCommand({
  cwd,
  command,
}) {
  const trimmedCommand = String(command ?? "").trim();
  if (!trimmedCommand) {
    throw new CLIError("SPAWN_COMMAND_REQUIRED", "A startup command is required to spawn a new agent terminal.");
  }

  const normalizedCwd = typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
  if (!normalizedCwd) {
    return trimmedCommand;
  }

  return `cd ${shellQuote(normalizedCwd)} && ${trimmedCommand}`;
}

function assertRouterRunning() {
  const runtime = inspectRuntimeState();
  if (!runtime?.pidAlive || runtime.mode !== "multi-agent-router") {
    throw new CLIError("ROUTER_NOT_RUNNING", "The global weixin-agent router is not running. Run `weixin-agent start` first.", {
      runtime,
    });
  }
}

async function pickCandidateApps(preferredApp = null) {
  const snapshot = await getTerminalSnapshot();
  const runningApps = snapshot.apps
    .filter((entry) => entry.running)
    .map((entry) => entry.app);

  return uniqueValues([
    preferredApp,
    snapshot.frontmostApp?.app ?? null,
    runningApps[0] ?? null,
    "iterm2",
    "terminal",
  ]);
}

function resolveSpawnProfile({
  requestedName = null,
  kind = null,
  app = null,
  command = null,
  cwd = null,
  autoNameAllowed = false,
  nameTemplate = null,
} = {}) {
  const config = loadConfig();
  const resolvedKind = normalizeAgentKind(kind ?? config.autoSpawnKind ?? "codex");
  const resolvedApp = typeof app === "string" && app.trim()
    ? app.trim()
    : (typeof config.autoSpawnApp === "string" && config.autoSpawnApp.trim()
      ? config.autoSpawnApp.trim()
      : "iterm2");
  const resolvedCommand = typeof command === "string" && command.trim()
    ? command.trim()
    : (typeof config.autoSpawnCommand === "string" && config.autoSpawnCommand.trim()
      ? config.autoSpawnCommand.trim()
      : (resolvedKind === "claude" ? "claude" : "codex"));
  const resolvedCwd = typeof cwd === "string" && cwd.trim()
    ? cwd.trim()
    : (typeof config.autoSpawnCwd === "string" && config.autoSpawnCwd.trim()
      ? config.autoSpawnCwd.trim()
      : process.cwd());
  const warmupMs = Math.max(0, readNumber(config.autoSpawnWarmupMs, 2500));
  const waitForAgentMs = Math.max(500, readNumber(config.autoSpawnWaitForAgentMs, 8000));
  const enabled = readBool(config.autoSpawnOnNoAgents, true);

  let displayName = null;
  let autoNamed = false;
  if (requestedName != null && String(requestedName).trim() !== "") {
    displayName = normalizeExplicitAgentDisplayName(requestedName);
  } else if (autoNameAllowed) {
    displayName = DEFAULT_BOOTSTRAP_AGENT_NAME;
    autoNamed = true;
  } else {
    throw new CLIError("AGENT_NAME_REQUIRED", "spawn requires --name <displayName>.");
  }

  return {
    enabled,
    kind: resolvedKind,
    app: resolvedApp,
    command: resolvedCommand,
    cwd: resolvedCwd,
    warmupMs,
    waitForAgentMs,
    displayName,
    autoNamed,
  };
}

async function waitForAgentRegistration(agentId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastAgent = loadAgent(agentId);

  while (Date.now() < deadline) {
    const current = loadAgent(agentId);
    if (current) {
      lastAgent = current;
      if (typeof current.lastSeenAt === "string" && current.lastSeenAt) {
        return current;
      }
      if (current.status === "error") {
        return current;
      }
    }
    await sleep(200);
  }

  return lastAgent;
}

function pickReusableNonDisconnectedAgent() {
  const candidates = listAgents({ includeDisconnected: false })
    .filter((agent) => ["starting", "connected"].includes(String(agent.status ?? "")))
    .filter((agent) => agent.pidAlive);

  candidates.sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));

  return candidates[0] ?? null;
}

function resolveRecoveryProfile(agent, overrides = {}) {
  const config = loadConfig();
  const launchProfile = agent?.launchProfile && typeof agent.launchProfile === "object"
    ? agent.launchProfile
    : {};
  const kind = normalizeAgentKind(
    overrides.kind
      ?? launchProfile.kind
      ?? agent?.kind
      ?? config.autoSpawnKind
      ?? "codex",
  );
  let command = typeof (overrides.command ?? launchProfile.command) === "string" && String(overrides.command ?? launchProfile.command).trim()
    ? String(overrides.command ?? launchProfile.command).trim()
    : "";
  if (!command) {
    if (kind === "claude") {
      command = "claude";
    } else if (kind === "codex") {
      command = "codex";
    }
  }

  if (!command) {
    throw new CLIError("AGENT_RECOVERY_UNSUPPORTED", `Agent ${agent?.displayName ?? "unknown"} cannot be auto-recovered because no startup command is known.`, {
      agentId: agent?.id ?? null,
      agentName: agent?.displayName ?? null,
    });
  }

  return {
    kind,
    app: typeof (overrides.app ?? launchProfile.app ?? agent?.sessionApp) === "string" && String(overrides.app ?? launchProfile.app ?? agent?.sessionApp).trim()
      ? String(overrides.app ?? launchProfile.app ?? agent?.sessionApp).trim()
      : (typeof config.autoSpawnApp === "string" && config.autoSpawnApp.trim() ? config.autoSpawnApp.trim() : "iterm2"),
    command,
    cwd: typeof (overrides.cwd ?? launchProfile.cwd ?? agent?.cwd) === "string" && String(overrides.cwd ?? launchProfile.cwd ?? agent?.cwd).trim()
      ? String(overrides.cwd ?? launchProfile.cwd ?? agent?.cwd).trim()
      : (typeof config.autoSpawnCwd === "string" && config.autoSpawnCwd.trim() ? config.autoSpawnCwd.trim() : process.cwd()),
  };
}

export async function spawnAgentSession({
  requestedName = null,
  kind = null,
  app = null,
  command = null,
  cwd = null,
  autoNameAllowed = false,
  nameTemplate = null,
  reason = "manual",
} = {}) {
  assertRouterRunning();

  const profile = resolveSpawnProfile({
    requestedName,
    kind,
    app,
    command,
    cwd,
    autoNameAllowed,
    nameTemplate,
  });

  const candidateApps = await pickCandidateApps(profile.app);
  const launchCommand = buildLaunchCommand({
    cwd: profile.cwd,
    command: profile.command,
  });

  let launched = null;
  let lastError = null;
  for (const candidateApp of candidateApps) {
    try {
      launched = await launchTerminalSession({
        app: candidateApp,
        command: launchCommand,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!launched?.target) {
    throw new CLIError("SPAWN_TERMINAL_FAILED", "Failed to create a new terminal session for the agent.", {
      requestedApp: profile.app,
      attemptedApps: candidateApps,
      error: lastError instanceof Error ? lastError.message : String(lastError ?? ""),
    });
  }

  const initialAgent = startDetachedAgentConnection({
    terminalTarget: launched.target,
    requestedName: profile.displayName,
    kind: profile.kind,
    cwd: profile.cwd,
    launchProfile: {
      app: launched.target.app,
      command: profile.command,
      cwd: profile.cwd,
      kind: profile.kind,
    },
  });
  const agent = await waitForAgentRegistration(initialAgent.id, profile.waitForAgentMs) ?? initialAgent;

  if (profile.warmupMs > 0) {
    await sleep(profile.warmupMs);
  }

  appendEvent({
    type: "agent.spawn.completed",
    payload: {
      agentId: agent.id,
      displayName: agent.displayName,
      kind: profile.kind,
      app: launched.target.app,
      command: profile.command,
      cwd: profile.cwd,
      autoNamed: profile.autoNamed,
      reason,
    },
  });

  return {
    ok: true,
    action: "spawn",
    reason,
    app: launched.target.app,
    startupCommand: launchCommand,
    autoNamed: profile.autoNamed,
    agent,
    terminalTarget: launched.target,
  };
}

export async function recoverAgentSession({
  displayName,
  kind = null,
  app = null,
  command = null,
  cwd = null,
  reason = "manual.recover",
} = {}) {
  assertRouterRunning();

  const requestedName = normalizeExplicitAgentDisplayName(displayName);
  const liveAgent = findAgentByDisplayName(requestedName, { onlyLive: true });
  if (liveAgent) {
    return {
      ok: true,
      action: "recover",
      reused: true,
      recovered: false,
      agent: liveAgent,
    };
  }

  const previousAgent = findLatestAgentByDisplayName(requestedName, { onlyLive: false });
  if (!previousAgent) {
    throw new CLIError("AGENT_NOT_FOUND", `No known agent named ${requestedName} was found.`, {
      displayName: requestedName,
    });
  }

  const profile = resolveRecoveryProfile(previousAgent, {
    kind,
    app,
    command,
    cwd,
  });

  const result = await spawnAgentSession({
    requestedName,
    kind: profile.kind,
    app: profile.app,
    command: profile.command,
    cwd: profile.cwd,
    autoNameAllowed: false,
    reason,
  });

  return {
    ...result,
    action: "recover",
    reused: false,
    recovered: true,
    previousAgent,
  };
}

export async function ensureOnDemandAgent({
  requestedName = null,
  kind = null,
  app = null,
  command = null,
  cwd = null,
  nameTemplate = null,
} = {}) {
  const profile = resolveSpawnProfile({
    requestedName,
    kind,
    app,
    command,
    cwd,
    autoNameAllowed: true,
    nameTemplate,
  });

  if (!profile.enabled) {
    return {
      ok: false,
      action: "spawn.ensure",
      enabled: false,
      reason: "disabled",
      agent: null,
    };
  }

  const liveAgents = listAgents({ onlyLive: true });
  if (liveAgents.length > 0) {
    return {
      ok: true,
      action: "spawn.ensure",
      enabled: true,
      reused: true,
      agent: liveAgents[0],
    };
  }

  if (requestedName != null && String(requestedName).trim() !== "") {
    const knownNamedAgent = findLatestAgentByDisplayName(requestedName, { onlyLive: false });
    if (knownNamedAgent) {
      return recoverAgentSession({
        displayName: requestedName,
        reason: "router.recover_named",
      });
    }
    throw new CLIError("AGENT_NOT_FOUND", `No known agent named ${normalizeExplicitAgentDisplayName(requestedName)} was found.`, {
      displayName: normalizeExplicitAgentDisplayName(requestedName),
    });
  }

  const reusableAgent = requestedName != null && String(requestedName).trim() !== ""
    ? null
    : pickReusableNonDisconnectedAgent();
  if (reusableAgent) {
    if (profile.warmupMs > 0) {
      await sleep(profile.warmupMs);
    }
    return {
      ok: true,
      action: "spawn.ensure",
      enabled: true,
      reused: true,
      agent: reusableAgent,
    };
  }

  return spawnAgentSession({
    requestedName: profile.displayName,
    kind: profile.kind,
    app: profile.app,
    command: profile.command,
    cwd: profile.cwd,
    autoNameAllowed: false,
    reason: "router.no_agents",
  });
}
