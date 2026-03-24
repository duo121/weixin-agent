import crypto from "node:crypto";
import fs from "node:fs";

import {
  resolveAgentAccountHistoryPath,
  resolveAgentConversationHistoryDir,
} from "./paths.mjs";

function pickItemFields(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const next = {
    type: item.type ?? "unknown",
  };

  const fieldNames = [
    "index",
    "label",
    "text",
    "fileName",
    "localPath",
    "mediaType",
    "size",
    "width",
    "height",
    "playtime",
    "playLength",
    "sampleRate",
    "bitsPerSample",
    "encodeType",
    "md5",
    "sha256",
    "url",
    "downloadError",
  ];

  for (const fieldName of fieldNames) {
    const value = item[fieldName];
    if (value !== undefined && value !== null && value !== "") {
      next[fieldName] = value;
    }
  }

  if (item.refMessage && typeof item.refMessage === "object") {
    next.refMessage = {
      ...(item.refMessage.title ? { title: item.refMessage.title } : {}),
      ...(item.refMessage.body ? { body: item.refMessage.body } : {}),
    };
  }

  return next;
}

export function appendConversationHistory({
  accountId,
  conversationId,
  direction,
  role,
  text = "",
  items = [],
  chatType = null,
  agentId = null,
  agentName = null,
  ticketId = null,
  parentTicketId = null,
  messageId = null,
  meta = {},
}) {
  const resolvedAccountId = String(accountId ?? "").trim() || "unknown-account";
  const resolvedConversationId = String(conversationId ?? "").trim() || "unknown-conversation";
  const filePath = resolveAgentAccountHistoryPath(resolvedAccountId);

  fs.mkdirSync(resolveAgentConversationHistoryDir(), { recursive: true });

  const normalizedItems = Array.isArray(items)
    ? items.map((item) => pickItemFields(item)).filter(Boolean)
    : [];

  const entry = {
    recordId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    channel: "wechat",
    accountId: resolvedAccountId,
    conversationId: resolvedConversationId,
    direction: String(direction ?? "").trim() || "unknown",
    role: String(role ?? "").trim() || "unknown",
    ...(chatType ? { chatType } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentName ? { agentName } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(parentTicketId ? { parentTicketId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(typeof text === "string" && text.length > 0 ? { text } : {}),
    ...(normalizedItems.length > 0 ? { items: normalizedItems } : {}),
    ...(meta && typeof meta === "object" && Object.keys(meta).length > 0 ? { meta } : {}),
  };

  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");

  return {
    filePath,
    entry,
  };
}
