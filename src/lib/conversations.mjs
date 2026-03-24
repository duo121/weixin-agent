import fs from "node:fs";

import {
  resolveAgentConversationRoutePath,
  resolveAgentConversationRoutesDir,
} from "./paths.mjs";

function normalizeValue(value) {
  return String(value ?? "").trim();
}

function ensureConversationRoutesDir() {
  fs.mkdirSync(resolveAgentConversationRoutesDir(), { recursive: true });
}

function readConversationRoute(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeConversationRoute(route) {
  ensureConversationRoutesDir();
  fs.writeFileSync(
    resolveAgentConversationRoutePath(route.accountId, route.conversationId),
    `${JSON.stringify(route, null, 2)}\n`,
    "utf8",
  );
  return route;
}

export function loadConversationRoute({
  accountId,
  conversationId,
}) {
  const normalizedAccountId = normalizeValue(accountId);
  const normalizedConversationId = normalizeValue(conversationId);
  if (!normalizedAccountId || !normalizedConversationId) {
    return null;
  }

  return readConversationRoute(
    resolveAgentConversationRoutePath(normalizedAccountId, normalizedConversationId),
  );
}

export function updateConversationRoute({
  accountId,
  conversationId,
  patch,
}) {
  const normalizedAccountId = normalizeValue(accountId);
  const normalizedConversationId = normalizeValue(conversationId);
  if (!normalizedAccountId || !normalizedConversationId) {
    return null;
  }

  const current = loadConversationRoute({
    accountId: normalizedAccountId,
    conversationId: normalizedConversationId,
  });

  return writeConversationRoute({
    accountId: normalizedAccountId,
    conversationId: normalizedConversationId,
    createdAt: current?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastAgentId: null,
    lastAgentName: null,
    lastAgentIds: [],
    lastAgentNames: [],
    lastTicketId: null,
    lastSource: null,
    lastRoutedAt: null,
    lastRepliedAt: null,
    routerReplyEnabled: false,
    ...current,
    ...patch,
  });
}

export function setConversationLastAgent({
  accountId,
  conversationId,
  agentId,
  agentName,
  ticketId = null,
  source = null,
  routedAt = null,
  repliedAt = null,
}) {
  return updateConversationRoute({
    accountId,
    conversationId,
    patch: {
      lastAgentId: normalizeValue(agentId) || null,
      lastAgentName: normalizeValue(agentName) || null,
      lastAgentIds: normalizeValue(agentId) ? [normalizeValue(agentId)] : [],
      lastAgentNames: normalizeValue(agentName) ? [normalizeValue(agentName)] : [],
      lastTicketId: normalizeValue(ticketId) || null,
      lastSource: normalizeValue(source) || null,
      lastRoutedAt: routedAt ?? new Date().toISOString(),
      lastRepliedAt: repliedAt ?? null,
    },
  });
}

export function setConversationLastAgents({
  accountId,
  conversationId,
  agents,
  ticketId = null,
  source = null,
}) {
  const normalizedAgents = Array.isArray(agents)
    ? agents
      .map((agent) => ({
        id: normalizeValue(agent?.id),
        name: normalizeValue(agent?.displayName ?? agent?.name),
      }))
      .filter((agent) => agent.id && agent.name)
    : [];

  return updateConversationRoute({
    accountId,
    conversationId,
    patch: {
      lastAgentId: normalizedAgents.length === 1 ? normalizedAgents[0].id : null,
      lastAgentName: normalizedAgents.length === 1 ? normalizedAgents[0].name : null,
      lastAgentIds: normalizedAgents.map((agent) => agent.id),
      lastAgentNames: normalizedAgents.map((agent) => agent.name),
      lastTicketId: normalizeValue(ticketId) || null,
      lastSource: normalizeValue(source) || null,
      lastRoutedAt: new Date().toISOString(),
      lastRepliedAt: null,
    },
  });
}

export function setConversationRouterReplyEnabled({
  accountId,
  conversationId,
  enabled,
}) {
  return updateConversationRoute({
    accountId,
    conversationId,
    patch: {
      routerReplyEnabled: Boolean(enabled),
    },
  });
}

export function clearConversationAgentReferences({
  agentName,
  agentIds = [],
} = {}) {
  const normalizedName = normalizeValue(agentName);
  const normalizedIds = new Set(
    (Array.isArray(agentIds) ? agentIds : [agentIds])
      .map((value) => normalizeValue(value))
      .filter(Boolean),
  );

  if (!normalizedName && normalizedIds.size === 0) {
    return {
      ok: true,
      updatedCount: 0,
    };
  }

  ensureConversationRoutesDir();
  if (!fs.existsSync(resolveAgentConversationRoutesDir())) {
    return {
      ok: true,
      updatedCount: 0,
    };
  }

  let updatedCount = 0;
  for (const entry of fs.readdirSync(resolveAgentConversationRoutesDir())) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const filePath = resolveAgentConversationRoutesDir() + `/${entry}`;
    const route = readConversationRoute(filePath);
    if (!route) {
      continue;
    }

    const names = Array.isArray(route.lastAgentNames)
      ? route.lastAgentNames.map((value) => normalizeValue(value)).filter(Boolean)
      : [];
    const ids = Array.isArray(route.lastAgentIds)
      ? route.lastAgentIds.map((value) => normalizeValue(value)).filter(Boolean)
      : [];

    const filteredPairs = ids.map((id, index) => ({
      id,
      name: names[index] ?? null,
    })).filter((item) => {
      if (normalizedIds.has(item.id)) {
        return false;
      }
      if (normalizedName && item.name === normalizedName) {
        return false;
      }
      return true;
    });

    const shouldClearSingle = (
      (normalizedName && normalizeValue(route.lastAgentName) === normalizedName) ||
      (normalizeValue(route.lastAgentId) && normalizedIds.has(normalizeValue(route.lastAgentId)))
    );

    const next = {
      ...route,
      lastAgentId: shouldClearSingle && filteredPairs.length === 1 ? filteredPairs[0].id : (shouldClearSingle ? null : route.lastAgentId),
      lastAgentName: shouldClearSingle && filteredPairs.length === 1 ? filteredPairs[0].name : (shouldClearSingle ? null : route.lastAgentName),
      lastAgentIds: filteredPairs.map((item) => item.id),
      lastAgentNames: filteredPairs.map((item) => item.name).filter(Boolean),
      updatedAt: new Date().toISOString(),
    };

    if (filteredPairs.length === 1) {
      next.lastAgentId = filteredPairs[0].id;
      next.lastAgentName = filteredPairs[0].name;
    } else if (filteredPairs.length === 0) {
      next.lastAgentId = null;
      next.lastAgentName = null;
    }

    writeConversationRoute(next);
    updatedCount += 1;
  }

  return {
    ok: true,
    updatedCount,
  };
}
