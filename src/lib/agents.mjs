import crypto from "node:crypto";
import fs from "node:fs";

import { loadConfig } from "./config.mjs";
import { CLIError } from "./errors.mjs";
import { resolveAgentAgentPath, resolveAgentAgentsDir } from "./paths.mjs";
import { isProcessAlive } from "./runtime.mjs";

const HEARTBEAT_STALE_MS = 45_000;
const NAME_TEMPLATE_PLACEHOLDER = "{n}";
const DEFAULT_AGENT_NAME_TEMPLATE = "元宝{n}号";

function ensureAgentsDir() {
  fs.mkdirSync(resolveAgentAgentsDir(), { recursive: true });
}

function normalizeAgentId(agentId) {
  return String(agentId ?? "").trim();
}

export function normalizeAgentKind(kind) {
  const value = String(kind ?? "").trim().toLowerCase();
  if (!value) {
    return "agent";
  }
  if (value === "custom") {
    return "agent";
  }
  return value;
}

export function defaultAgentNameBase(kind) {
  const normalized = normalizeAgentKind(kind);
  if (normalized === "codex") {
    return "codex";
  }
  if (normalized === "claude") {
    return "claude";
  }
  return "agent";
}

export function normalizeExplicitAgentDisplayName(requestedName) {
  const normalized = String(requestedName ?? "").trim().replace(/^@+/u, "");
  if (!normalized) {
    throw new CLIError("AGENT_NAME_REQUIRED", "A full agent display name is required.");
  }
  if (/[\r\n]/u.test(normalized)) {
    throw new CLIError("AGENT_NAME_INVALID", "Agent display names cannot contain newlines.", {
      displayName: normalized,
    });
  }
  if (/[,\uFF0C\u3001]/u.test(normalized)) {
    throw new CLIError("AGENT_NAME_INVALID", "Agent display names cannot contain comma separators.", {
      displayName: normalized,
    });
  }
  if (/\s/u.test(normalized)) {
    throw new CLIError("AGENT_NAME_INVALID", "Agent display names cannot contain whitespace. Use names such as 名字2号 or codex-2.", {
      displayName: normalized,
    });
  }
  return normalized;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeAgentNameTemplate(template) {
  const value = String(template ?? "").trim();
  if (!value) {
    return DEFAULT_AGENT_NAME_TEMPLATE;
  }

  if (/\{n\}/iu.test(value)) {
    return value.replace(/\{n\}/giu, NAME_TEMPLATE_PLACEHOLDER);
  }

  if (/\{index\}/iu.test(value)) {
    return value.replace(/\{index\}/giu, NAME_TEMPLATE_PLACEHOLDER);
  }

  if (/%d/g.test(value)) {
    return value.replace(/%d/g, NAME_TEMPLATE_PLACEHOLDER);
  }

  if (/(?<![A-Za-z0-9])(n|x)(?![A-Za-z0-9])/u.test(value)) {
    return value.replace(/(?<![A-Za-z0-9])(n|x)(?![A-Za-z0-9])/u, NAME_TEMPLATE_PLACEHOLDER);
  }

  if (/\d+/.test(value)) {
    return value.replace(/\d+/, NAME_TEMPLATE_PLACEHOLDER);
  }

  return `${value}${NAME_TEMPLATE_PLACEHOLDER}`;
}

function splitAgentNameTemplate(template) {
  const normalized = normalizeAgentNameTemplate(template);
  const [prefix = "", suffix = ""] = normalized.split(NAME_TEMPLATE_PLACEHOLDER);
  return {
    template: normalized,
    prefix,
    suffix,
  };
}

function renderAgentNameFromTemplate(template, index) {
  return normalizeAgentNameTemplate(template).replace(NAME_TEMPLATE_PLACEHOLDER, String(index));
}

function extractTemplateIndexes(template, takenNames) {
  const { prefix, suffix } = splitAgentNameTemplate(template);
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)${escapeRegExp(suffix)}$`, "u");
  const indexes = new Set();

  for (const name of takenNames) {
    const match = String(name).match(pattern);
    if (!match) {
      continue;
    }
    const index = Number(match[1]);
    if (Number.isInteger(index) && index > 0) {
      indexes.add(index);
    }
  }

  return indexes;
}

function pickSmallestAvailableTemplateName(template, takenNames) {
  const normalized = normalizeAgentNameTemplate(template);
  const usedIndexes = extractTemplateIndexes(normalized, takenNames);
  let index = 1;

  while (usedIndexes.has(index) || takenNames.has(renderAgentNameFromTemplate(normalized, index))) {
    index += 1;
  }

  return {
    displayName: renderAgentNameFromTemplate(normalized, index),
    index,
    template: normalized,
  };
}

export function resolveConfiguredAgentNameTemplate(kind = "agent") {
  const config = loadConfig();
  const normalizedKind = normalizeAgentKind(kind);
  const perKind = config.agentNameTemplates;

  if (perKind && typeof perKind === "object") {
    const kindTemplate = perKind[normalizedKind] ?? perKind.default;
    if (typeof kindTemplate === "string" && kindTemplate.trim() !== "") {
      return normalizeAgentNameTemplate(kindTemplate);
    }
  }

  return normalizeAgentNameTemplate(config.agentNameTemplate);
}

function readAgentFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeAgent(agent) {
  ensureAgentsDir();
  fs.writeFileSync(
    resolveAgentAgentPath(agent.id),
    `${JSON.stringify(agent, null, 2)}\n`,
    "utf8",
  );
  return agent;
}

function extractIndexedNames(base, takenNames) {
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedBase}(\\d+)$`, "u");
  const indexes = new Set();

  for (const name of takenNames) {
    const match = name.match(pattern);
    if (!match) {
      continue;
    }
    const index = Number(match[1]);
    if (Number.isInteger(index) && index > 0) {
      indexes.add(index);
    }
  }

  return indexes;
}

function pickSmallestAvailableDisplayName(base, takenNames) {
  const usedIndexes = extractIndexedNames(base, takenNames);
  let index = 1;
  while (usedIndexes.has(index) || takenNames.has(`${base}${index}`)) {
    index += 1;
  }
  return {
    displayName: `${base}${index}`,
    index,
  };
}

export function parseRequestedAgentName(requestedName) {
  const value = String(requestedName ?? "").trim();
  if (!value) {
    return {
      mode: "allocate",
      base: null,
      displayName: null,
    };
  }

  const explicitMatch = value.match(/^(.*?)(\d+)$/u);
  if (explicitMatch && explicitMatch[1].trim() !== "") {
    return {
      mode: "explicit",
      base: explicitMatch[1].trim(),
      displayName: value,
    };
  }

  return {
    mode: "allocate",
    base: value,
    displayName: null,
  };
}

export function loadAgent(agentId) {
  const normalized = normalizeAgentId(agentId);
  if (!normalized) {
    return null;
  }
  return readAgentFile(resolveAgentAgentPath(normalized));
}

export function inspectAgent(agent) {
  if (!agent) {
    return null;
  }

  const pidAlive = isProcessAlive(agent.pid);
  const heartbeatAt = typeof agent.lastSeenAt === "string" ? Date.parse(agent.lastSeenAt) : NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatAt) ? Math.max(0, Date.now() - heartbeatAt) : null;
  const heartbeatFresh = heartbeatAgeMs !== null ? heartbeatAgeMs <= HEARTBEAT_STALE_MS : false;
  const connectedStatus = new Set(["starting", "connected", "busy"]);
  const live = connectedStatus.has(agent.status) && pidAlive && heartbeatFresh;

  return {
    ...agent,
    pidAlive,
    heartbeatAgeMs,
    heartbeatFresh,
    live,
    busy: Boolean(agent.currentTicketId),
  };
}

export function listAgents({ includeDisconnected = true, onlyLive = false } = {}) {
  try {
    if (!fs.existsSync(resolveAgentAgentsDir())) {
      return [];
    }

    const records = fs.readdirSync(resolveAgentAgentsDir())
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readAgentFile(resolveAgentAgentPath(entry.slice(0, -5))))
      .filter(Boolean)
      .map((entry) => inspectAgent(entry))
      .filter(Boolean)
      .filter((entry) => (includeDisconnected ? true : entry.status !== "disconnected"))
      .filter((entry) => (onlyLive ? entry.live : true))
      .sort((left, right) => {
        const displayCompare = String(left.displayName ?? "").localeCompare(String(right.displayName ?? ""));
        if (displayCompare !== 0) {
          return displayCompare;
        }
        return String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
      });

    return records;
  } catch {
    return [];
  }
}

export function findAgentBySessionHandle(sessionHandle, { onlyLive = false } = {}) {
  const normalized = String(sessionHandle ?? "").trim();
  if (!normalized) {
    return null;
  }

  return listAgents({ includeDisconnected: !onlyLive, onlyLive })
    .find((agent) => agent.sessionHandle === normalized) ?? null;
}

export function findAgentByDisplayName(displayName, { onlyLive = false } = {}) {
  const normalized = String(displayName ?? "").trim().replace(/^@+/u, "");
  if (!normalized) {
    return null;
  }

  return listAgents({ includeDisconnected: !onlyLive, onlyLive })
    .find((agent) => agent.displayName === normalized) ?? null;
}

export function findLatestAgentByDisplayName(displayName, { onlyLive = false } = {}) {
  const normalized = String(displayName ?? "").trim().replace(/^@+/u, "");
  if (!normalized) {
    return null;
  }

  const matches = listAgents({ includeDisconnected: !onlyLive, onlyLive })
    .filter((agent) => agent.displayName === normalized)
    .sort((left, right) => {
      const leftTime = Date.parse(left.connectedAt ?? left.createdAt ?? left.lastSeenAt ?? "") || 0;
      const rightTime = Date.parse(right.connectedAt ?? right.createdAt ?? right.lastSeenAt ?? "") || 0;
      return rightTime - leftTime;
    });

  return matches[0] ?? null;
}

export function findAgentsByDisplayName(displayName, { onlyLive = false } = {}) {
  const normalized = String(displayName ?? "").trim().replace(/^@+/u, "");
  if (!normalized) {
    return [];
  }

  return listAgents({ includeDisconnected: !onlyLive, onlyLive })
    .filter((agent) => agent.displayName === normalized)
    .sort((left, right) => {
      const leftTime = Date.parse(left.connectedAt ?? left.createdAt ?? left.lastSeenAt ?? "") || 0;
      const rightTime = Date.parse(right.connectedAt ?? right.createdAt ?? right.lastSeenAt ?? "") || 0;
      return rightTime - leftTime;
    });
}

export function reserveDisplayName({
  requestedName = null,
  excludeAgentId = null,
} = {}) {
  const connectedAgents = listAgents({ onlyLive: true });
  const takenNames = new Set(
    connectedAgents
      .filter((agent) => agent.id !== excludeAgentId)
      .map((agent) => agent.displayName)
      .filter((value) => typeof value === "string" && value.trim() !== ""),
  );
  const displayName = normalizeExplicitAgentDisplayName(requestedName);
  if (takenNames.has(displayName)) {
    throw new CLIError("AGENT_NAME_IN_USE", `Agent name ${displayName} is already in use.`, {
      displayName,
    });
  }
  return {
    displayName,
    nameBase: displayName,
    allocation: "manual-explicit",
    nameTemplate: null,
    nameIndex: null,
  };
}

export function allocateDisplayNameFromTemplate({
  template = null,
  kind = "agent",
  excludeAgentId = null,
} = {}) {
  const connectedAgents = listAgents({ onlyLive: true });
  const takenNames = new Set(
    connectedAgents
      .filter((agent) => agent.id !== excludeAgentId)
      .map((agent) => agent.displayName)
      .filter((value) => typeof value === "string" && value.trim() !== ""),
  );
  const resolvedTemplate = template
    ? normalizeAgentNameTemplate(template)
    : resolveConfiguredAgentNameTemplate(kind);
  const allocated = pickSmallestAvailableTemplateName(resolvedTemplate, takenNames);
  const parts = splitAgentNameTemplate(resolvedTemplate);
  return {
    displayName: allocated.displayName,
    nameBase: parts.prefix || defaultAgentNameBase(kind),
    allocation: "template-orchestrated",
    nameTemplate: allocated.template,
    nameIndex: allocated.index,
  };
}

export function createAgentRecord({
  terminalTarget,
  requestedName = null,
  kind = "agent",
  pid = null,
  logPath = null,
  cwd = null,
  launchProfile = null,
}) {
  if (!terminalTarget?.handle) {
    throw new CLIError("TERMINAL_SESSION_REQUIRED", "Agent registration requires a resolved terminal session.");
  }

  const existing = findAgentBySessionHandle(terminalTarget.handle, { onlyLive: true });
  if (existing) {
    throw new CLIError("AGENT_ALREADY_CONNECTED", `Terminal session ${terminalTarget.handle} is already connected as ${existing.displayName}.`, {
      agent: existing,
    });
  }

  const { displayName, nameBase, allocation, nameTemplate, nameIndex } = reserveDisplayName({
    requestedName,
  });
  const now = new Date().toISOString();

  return writeAgent({
    id: `agent_${crypto.randomUUID().slice(0, 8)}`,
    status: "starting",
    kind: normalizeAgentKind(kind),
    displayName,
    nameBase,
    allocation,
    nameTemplate,
    nameIndex,
    sessionHandle: terminalTarget.handle,
    sessionApp: terminalTarget.app,
    target: terminalTarget,
    currentTicketId: null,
    pid,
    logPath,
    cwd,
    launchProfile: launchProfile && typeof launchProfile === "object"
      ? {
          app: typeof launchProfile.app === "string" ? launchProfile.app : null,
          command: typeof launchProfile.command === "string" ? launchProfile.command : null,
          cwd: typeof launchProfile.cwd === "string" ? launchProfile.cwd : null,
          kind: typeof launchProfile.kind === "string" ? normalizeAgentKind(launchProfile.kind) : normalizeAgentKind(kind),
        }
      : null,
    createdAt: now,
    connectedAt: null,
    lastSeenAt: null,
    disconnectedAt: null,
    lastError: null,
  });
}

export function updateAgent(agentId, patch) {
  const current = loadAgent(agentId);
  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    id: current.id,
    updatedAt: new Date().toISOString(),
  };

  return writeAgent(next);
}

export function setAgentTicket(agentId, ticketId) {
  const current = loadAgent(agentId);
  if (!current) {
    return null;
  }

  let nextStatus = current.status;
  if (ticketId) {
    nextStatus = "busy";
  } else if (!["disconnecting", "disconnected", "error"].includes(String(current.status ?? ""))) {
    nextStatus = "connected";
  }

  return updateAgent(agentId, {
    currentTicketId: ticketId,
    status: nextStatus,
  });
}

export function renameAgent(agentId, requestedName) {
  const current = loadAgent(agentId);
  if (!current) {
    throw new CLIError("AGENT_NOT_FOUND", `Agent ${agentId} was not found.`, {
      agentId,
    });
  }

  const { displayName, nameBase, allocation, nameTemplate, nameIndex } = reserveDisplayName({
    requestedName,
    excludeAgentId: current.id,
  });

  return updateAgent(agentId, {
    displayName,
    nameBase,
    allocation,
    nameTemplate,
    nameIndex,
    renamedAt: new Date().toISOString(),
  });
}

export function markAgentDisconnected(agentId, reason = "disconnected") {
  const current = loadAgent(agentId);
  if (!current) {
    return null;
  }

  return updateAgent(agentId, {
    status: "disconnected",
    currentTicketId: null,
    disconnectedAt: new Date().toISOString(),
    lastError: reason === "disconnected" ? null : reason,
  });
}

export function deleteAgentRecord(agentId) {
  const current = loadAgent(agentId);
  if (!current) {
    return null;
  }

  try {
    fs.unlinkSync(resolveAgentAgentPath(agentId));
  } catch {
    return null;
  }

  return current;
}
