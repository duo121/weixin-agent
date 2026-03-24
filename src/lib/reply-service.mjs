import { buildWechatMediaItem, uploadMediaInputToWechat } from "./wechat-media.mjs";
import { setAgentTicket } from "./agents.mjs";
import { loadAccountCredentials } from "./accounts.mjs";
import { appendEvent } from "./events.mjs";
import { appendConversationHistory } from "./history.mjs";
import { CLIError } from "./errors.mjs";
import { updateTicket, loadTicket } from "./tickets.mjs";
import { sendMessage, sendTextMessage } from "./wechat-api.mjs";

function formatReplyText(ticket, text) {
  const replyText = String(text ?? "").trim();
  const agentName = String(ticket?.agentName ?? "").trim();
  if (!agentName) {
    return replyText;
  }

  const prefixedForms = [
    `[${agentName}]`,
    `${agentName}:`,
    `${agentName}：`,
  ];

  if (prefixedForms.some((prefix) => replyText.startsWith(prefix))) {
    return replyText;
  }

  return `[${agentName}] ${replyText}`.trim();
}

export async function sendTicketReply({
  ticketId,
  text,
  mediaInput = null,
}) {
  const ticket = loadTicket(ticketId);
  if (!ticket) {
    throw new CLIError("TICKET_NOT_FOUND", `Ticket ${ticketId} was not found.`, {
      ticketId,
    });
  }

  if (ticket.status !== "pending") {
    throw new CLIError("TICKET_NOT_PENDING", `Ticket ${ticketId} is already ${ticket.status}.`, {
      ticketId,
      status: ticket.status,
    });
  }

  const normalizedMediaInput = typeof mediaInput === "string" && mediaInput.trim()
    ? mediaInput.trim()
    : null;

  const replyText = formatReplyText(ticket, text);
  if (!replyText && !normalizedMediaInput) {
    throw new CLIError("REPLY_TEXT_REQUIRED", "Reply text is required.");
  }

  const account = loadAccountCredentials(ticket.accountId);
  if (!account?.configured || !account.token) {
    throw new CLIError("ACCOUNT_NOT_CONFIGURED", `Account ${ticket.accountId} is missing local credentials.`, {
      accountId: ticket.accountId,
    });
  }

  if (!ticket.contextToken || !ticket.toUserId) {
    throw new CLIError("TICKET_REPLY_TARGET_MISSING", `Ticket ${ticketId} is missing WeChat reply routing data.`, {
      ticketId,
    });
  }

  let result;
  let mediaKind = null;

  if (!normalizedMediaInput) {
    result = await sendTextMessage({
      accountId: account.id,
      baseUrl: account.baseUrl,
      token: account.token,
      toUserId: ticket.toUserId,
      contextToken: ticket.contextToken,
      text: replyText,
    });

    appendConversationHistory({
      accountId: account.id,
      conversationId: ticket.conversationId ?? ticket.toUserId,
      direction: "outbound",
      role: "agent",
      text: replyText,
      chatType: ticket.chatType ?? null,
      agentId: ticket.agentId ?? null,
      agentName: ticket.agentName ?? null,
      ticketId,
      parentTicketId: ticket.parentTicketId ?? null,
      messageId: result.messageId,
      meta: {
        toUserId: ticket.toUserId ?? null,
        senderUserId: ticket.senderUserId ?? null,
        groupId: ticket.groupId ?? null,
        sessionId: ticket.sessionId ?? null,
      },
    });
  } else {
    const uploadedMedia = await uploadMediaInputToWechat({
      accountId: account.id,
      baseUrl: account.baseUrl,
      token: account.token,
      toUserId: ticket.toUserId,
      mediaInput: normalizedMediaInput,
    });
    mediaKind = uploadedMedia.kind;

    if (replyText) {
      await sendTextMessage({
        accountId: account.id,
        baseUrl: account.baseUrl,
        token: account.token,
        toUserId: ticket.toUserId,
        contextToken: ticket.contextToken,
        text: replyText,
      });

      appendConversationHistory({
        accountId: account.id,
        conversationId: ticket.conversationId ?? ticket.toUserId,
        direction: "outbound",
        role: "agent",
        text: replyText,
        chatType: ticket.chatType ?? null,
        agentId: ticket.agentId ?? null,
        agentName: ticket.agentName ?? null,
        ticketId,
        parentTicketId: ticket.parentTicketId ?? null,
        meta: {
          toUserId: ticket.toUserId ?? null,
          senderUserId: ticket.senderUserId ?? null,
          groupId: ticket.groupId ?? null,
          sessionId: ticket.sessionId ?? null,
        },
      });
    }

    const mediaItem = buildWechatMediaItem(uploadedMedia);
    result = await sendMessage({
      accountId: account.id,
      baseUrl: account.baseUrl,
      token: account.token,
      toUserId: ticket.toUserId,
      contextToken: ticket.contextToken,
      itemList: [mediaItem],
    });

    appendConversationHistory({
      accountId: account.id,
      conversationId: ticket.conversationId ?? ticket.toUserId,
      direction: "outbound",
      role: "agent",
      text: "",
      items: [{
        type: uploadedMedia.kind,
        fileName: uploadedMedia.fileName,
        localPath: uploadedMedia.filePath,
        size: uploadedMedia.fileSize,
        mediaType: mediaKind === "image"
          ? "image/*"
          : (mediaKind === "video" ? "video/*" : "application/octet-stream"),
      }],
      chatType: ticket.chatType ?? null,
      agentId: ticket.agentId ?? null,
      agentName: ticket.agentName ?? null,
      ticketId,
      parentTicketId: ticket.parentTicketId ?? null,
      messageId: result.messageId,
      meta: {
        toUserId: ticket.toUserId ?? null,
        senderUserId: ticket.senderUserId ?? null,
        groupId: ticket.groupId ?? null,
        sessionId: ticket.sessionId ?? null,
        wechatItemType: mediaItem.type,
      },
    });
  }

  const next = updateTicket(ticketId, {
    status: "replied",
    replyText: replyText || null,
    replyMedia: normalizedMediaInput
      ? {
          input: normalizedMediaInput,
          kind: mediaKind,
        }
      : null,
    replyMessageId: result.messageId,
    repliedAt: new Date().toISOString(),
  });

  if (ticket.agentId) {
    setAgentTicket(ticket.agentId, null);
  }

  appendEvent({
    type: "wechat.ticket.replied",
    accountId: account.id,
    conversationId: ticket.conversationId ?? ticket.toUserId,
    payload: {
      ticketId,
      agentId: ticket.agentId ?? null,
      agentName: ticket.agentName ?? null,
      preview: replyText.slice(0, 240),
      replyMessageId: result.messageId,
      mediaKind,
      sessionHandle: ticket.sessionHandle ?? null,
    },
  });

  return {
    ok: true,
    action: "reply",
    ticket: next,
    replyMessageId: result.messageId,
  };
}
