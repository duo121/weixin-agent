import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveAgentTicketsDir } from "./paths.mjs";

function ensureTicketsDir() {
  fs.mkdirSync(resolveAgentTicketsDir(), { recursive: true });
}

function normalizeTicketId(ticketId) {
  return String(ticketId ?? "").trim();
}

export function resolveTicketPath(ticketId) {
  return path.join(resolveAgentTicketsDir(), `${normalizeTicketId(ticketId)}.json`);
}

export function loadTicket(ticketId) {
  const normalized = normalizeTicketId(ticketId);
  if (!normalized) {
    return null;
  }

  const filePath = resolveTicketPath(normalized);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeTicket(ticket) {
  ensureTicketsDir();
  fs.writeFileSync(
    resolveTicketPath(ticket.id),
    `${JSON.stringify(ticket, null, 2)}\n`,
    "utf8",
  );
  return ticket;
}

export function createTicket({
  accountId,
  agentId,
  agentName,
  sessionHandle,
  sessionApp,
  toUserId,
  conversationId = null,
  chatType = "direct",
  senderUserId = null,
  groupId = null,
  sessionId = null,
  contextToken,
  inboundText,
  inboundItems = [],
  messageId = null,
  parentTicketId = null,
  transferSourceAgentId = null,
  transferSourceAgentName = null,
  transferDepth = 0,
  routeSource = null,
}) {
  const now = new Date().toISOString();
  const ticket = {
    id: `wxr_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    accountId,
    agentId,
    agentName,
    sessionHandle,
    sessionApp,
    toUserId,
    conversationId,
    chatType,
    senderUserId,
    groupId,
    sessionId,
    contextToken,
    inboundText,
    inboundItems: Array.isArray(inboundItems) ? inboundItems : [],
    messageId,
    parentTicketId,
    transferSourceAgentId,
    transferSourceAgentName,
    transferDepth,
    routeSource,
    replyText: null,
    replyMedia: null,
    replyMessageId: null,
    repliedAt: null,
  };

  return writeTicket(ticket);
}

export function updateTicket(ticketId, patch) {
  const current = loadTicket(ticketId);
  if (!current) {
    return null;
  }

  return writeTicket({
    ...current,
    ...patch,
    id: current.id,
    updatedAt: new Date().toISOString(),
  });
}

export function listTickets({
  status = null,
  sessionHandle = null,
} = {}) {
  try {
    if (!fs.existsSync(resolveAgentTicketsDir())) {
      return [];
    }

    return fs.readdirSync(resolveAgentTicketsDir())
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(resolveAgentTicketsDir(), entry), "utf8"),
          );
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((ticket) => (status ? ticket.status === status : true))
      .filter((ticket) => (sessionHandle ? ticket.sessionHandle === sessionHandle : true))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  } catch {
    return [];
  }
}

export function listPendingTicketsForSession(sessionHandle) {
  return listTickets({
    status: "pending",
    sessionHandle,
  });
}

export function listPendingTicketsForAgent(agentId) {
  return listTickets({
    status: "pending",
  }).filter((ticket) => ticket.agentId === agentId);
}

export function failPendingTicketsForAgent(agentId, {
  status = "failed",
  errorMessage = "agent removed",
} = {}) {
  const pendingTickets = listPendingTicketsForAgent(agentId);
  const failedAt = new Date().toISOString();

  return pendingTickets
    .map((ticket) => updateTicket(ticket.id, {
      status,
      failedAt,
      errorMessage,
    }))
    .filter(Boolean);
}
