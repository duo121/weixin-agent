import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { appendEvent } from "./events.mjs";
import { appendConversationHistory } from "./history.mjs";
import {
  resolveAgentAccountHistoryPath,
  resolveWeixinSyncBufPath,
} from "./paths.mjs";
import { createTicket, listPendingTicketsForSession, updateTicket } from "./tickets.mjs";
import { isTerminalCaptureBusy } from "./terminal-observer.mjs";
import {
  captureTerminalTarget,
  focusTerminalTarget,
  pressKeyOnTerminalTarget,
  sendNativeTextToTerminalTarget,
  sendTextToTerminalTarget,
} from "./terminal-control.mjs";
import {
  extractInboundItems,
  extractInboundText,
  extractWechatConversationMeta,
  getUpdates,
  sendTextMessage,
  shouldProcessInboundMessage,
} from "./wechat-api.mjs";
import { materializeInboundWechatItems } from "./wechat-inbound-media.mjs";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const INPUT_FOCUS_DELAY_MS = 120;
const SUBMIT_FOCUS_DELAY_MS = 80;
const SUBMIT_KEYS = Object.freeze(["return", "enter"]);
const PROMPT_CLI_COMMAND = "weixin-agent";

function loadSyncBuf(accountId) {
  const filePath = resolveWeixinSyncBufPath(accountId);
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.get_updates_buf === "string" ? parsed.get_updates_buf : "";
  } catch {
    return "";
  }
}

function saveSyncBuf(accountId, getUpdatesBuf) {
  const filePath = resolveWeixinSyncBufPath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }), "utf8");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function truncateText(text, maxLength = 240) {
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildReplyCommand({
  cliPath = process.argv[1],
  nodePath = process.execPath,
  ticketId,
}) {
  return `${PROMPT_CLI_COMMAND} reply --ticket ${shellQuote(ticketId)} --stdin`;
}

function buildInjectedPrompt({
  ticket,
  cliPath,
  nodePath,
}) {
  const replyCommand = buildReplyCommand({
    cliPath,
    nodePath,
    ticketId: ticket.id,
  });

  return [
    "[Weixin Ticket]",
    `ticket: ${ticket.id}`,
    `from_user: ${ticket.toUserId}`,
    "",
    `history_jsonl: ${resolveAgentAccountHistoryPath(ticket.accountId)}`,
    `current_conversation_id: ${ticket.conversationId ?? ticket.toUserId}`,
    "",
    "User message:",
    ticket.inboundText,
    "",
    "Final reply command:",
    `cat <<'WXAGENT_REPLY' | ${replyCommand}`,
    "<replace this line with the final WeChat reply text>",
    "WXAGENT_REPLY",
  ].join("\n");
}

async function injectPromptIntoSession({
  terminalTarget,
  promptText,
  abortSignal,
}) {
  let focusMethod = null;
  try {
    await focusTerminalTarget(terminalTarget);
    focusMethod = {
      ok: true,
      method: "applescript.focus",
      sessionId: terminalTarget.sessionId,
    };
    await sleep(INPUT_FOCUS_DELAY_MS, abortSignal);
  } catch (focusError) {
    focusMethod = {
      ok: false,
      method: "applescript.focus",
      sessionId: terminalTarget.sessionId,
      error: focusError instanceof Error ? focusError.message : String(focusError),
    };
  }

  let inputMethod = null;
  try {
    inputMethod = await sendNativeTextToTerminalTarget(terminalTarget, promptText, {
      newline: false,
    });
  } catch (nativeError) {
    try {
      inputMethod = await sendTextToTerminalTarget(terminalTarget, promptText, {
        newline: false,
      });
      inputMethod = {
        ...inputMethod,
        fallbackFrom: nativeError instanceof Error ? nativeError.message : String(nativeError),
      };
    } catch (ttyError) {
      const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
      const ttyMessage = ttyError instanceof Error ? ttyError.message : String(ttyError);
      throw new Error(`Failed to inject prompt into terminal session. native=${nativeMessage}; tty=${ttyMessage}`);
    }
  }

  await sleep(SUBMIT_FOCUS_DELAY_MS, abortSignal);

  let submitMethod = null;
  const submitErrors = [];
  for (const key of SUBMIT_KEYS) {
    try {
      await focusTerminalTarget(terminalTarget);
      await sleep(SUBMIT_FOCUS_DELAY_MS, abortSignal);
      submitMethod = await pressKeyOnTerminalTarget(terminalTarget, key);
      break;
    } catch (pressError) {
      submitErrors.push({
        key,
        error: pressError instanceof Error ? pressError.message : String(pressError),
      });
    }
  }

  if (!submitMethod) {
    const pressMessage = submitErrors
      .map(({ key, error }) => `${key}=${error}`)
      .join("; ");
    throw new Error(`Prompt text was injected, but key submission failed: ${pressMessage}`);
  }

  return {
    focusMethod,
    inputMethod,
    submitMethod,
    submitAttempts: submitErrors.length > 0 ? submitErrors : undefined,
  };
}

async function sendBusyReply({
  account,
  message,
  reason,
}) {
  if (!message.context_token) {
    return;
  }

  await sendTextMessage({
    accountId: account.id,
    baseUrl: account.baseUrl,
    token: account.token,
    toUserId: message.from_user_id,
    contextToken: message.context_token,
    text: reason,
  });

  const messageMeta = extractWechatConversationMeta(message);
  appendConversationHistory({
    accountId: account.id,
    conversationId: messageMeta.conversationId,
    direction: "outbound",
    role: "router",
    text: reason,
    chatType: messageMeta.chatType,
    meta: {
      toUserId: message.from_user_id ?? null,
      senderUserId: messageMeta.senderUserId ?? null,
      groupId: messageMeta.groupId ?? null,
      sessionId: messageMeta.sessionId ?? null,
    },
  });
}

export async function runWeChatReplyBridge({
  account,
  terminalTarget,
  abortSignal,
  cliPath = process.argv[1],
  nodePath = process.execPath,
}) {
  let getUpdatesBuf = loadSyncBuf(account.id);
  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  appendEvent({
    type: "bridge.monitor.started",
    accountId: account.id,
    payload: {
      sessionHandle: terminalTarget.handle,
      baseUrl: account.baseUrl,
      mode: "session-ticket-reply",
    },
  });

  while (!abortSignal?.aborted) {
    try {
      const response = await getUpdates({
        accountId: account.id,
        baseUrl: account.baseUrl,
        token: account.token,
        getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (Number(response.longpolling_timeout_ms) > 0) {
        nextTimeoutMs = Number(response.longpolling_timeout_ms);
      }

      if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
        consecutiveFailures += 1;
        appendEvent({
          type: "bridge.monitor.api_error",
          accountId: account.id,
          payload: {
            ret: response.ret ?? null,
            errcode: response.errcode ?? null,
            errmsg: response.errmsg ?? null,
            consecutiveFailures,
          },
        });
        try {
          await sleep(
            consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
            abortSignal,
          );
        } catch {
          break;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
        }
        continue;
      }

      consecutiveFailures = 0;

      if (typeof response.get_updates_buf === "string" && response.get_updates_buf !== "") {
        getUpdatesBuf = response.get_updates_buf;
        saveSyncBuf(account.id, getUpdatesBuf);
      }

      for (const message of response.msgs ?? []) {
        if (!shouldProcessInboundMessage(message)) {
          continue;
        }

        const messageMeta = extractWechatConversationMeta(message);
        const conversationId = messageMeta.conversationId;
        const inboundText = extractInboundText(message);
        const inboundMediaItems = await materializeInboundWechatItems({
          accountId: account.id,
          message,
        });
        const inboundItems = inboundMediaItems.length > 0
          ? inboundMediaItems
          : extractInboundItems(message).filter((item) => item.type !== "text");

        appendConversationHistory({
          accountId: account.id,
          conversationId,
          direction: "inbound",
          role: "user",
          text: inboundText,
          items: inboundItems,
          chatType: messageMeta.chatType,
          messageId: message.message_id ?? null,
          meta: {
            fromUserId: message.from_user_id ?? null,
            senderUserId: messageMeta.senderUserId ?? null,
            groupId: messageMeta.groupId ?? null,
            sessionId: messageMeta.sessionId ?? null,
          },
        });

        appendEvent({
          type: "wechat.message.received",
          accountId: account.id,
          conversationId,
          payload: {
            preview: truncateText(inboundText),
            messageId: message.message_id ?? null,
            contextToken: message.context_token ?? null,
            sessionHandle: terminalTarget.handle,
          },
        });

        try {
          if (!message.context_token) {
            throw new Error("Inbound WeChat message is missing context_token, cannot create a reply ticket.");
          }

          const pendingTickets = listPendingTicketsForSession(terminalTarget.handle);
          if (pendingTickets.length > 0) {
            await sendBusyReply({
              account,
              message,
              reason: "当前 Codex 会话还有未完成的微信任务，请稍后再发。",
            });
            appendEvent({
              type: "wechat.message.rejected_busy",
              accountId: account.id,
              conversationId,
              payload: {
                preview: truncateText(inboundText),
                pendingTicketIds: pendingTickets.map((ticket) => ticket.id),
                sessionHandle: terminalTarget.handle,
              },
            });
            continue;
          }

          let captureText = "";
          try {
            captureText = await captureTerminalTarget(terminalTarget);
          } catch {
            captureText = "";
          }

          if (captureText && isTerminalCaptureBusy(captureText)) {
            await sendBusyReply({
              account,
              message,
              reason: "当前 Codex 会话正在处理其他任务，请稍后再发。",
            });
            appendEvent({
              type: "wechat.message.rejected_busy",
              accountId: account.id,
              conversationId,
              payload: {
                preview: truncateText(inboundText),
                busySource: "terminal-capture",
                sessionHandle: terminalTarget.handle,
              },
            });
            continue;
          }

          const ticket = createTicket({
            accountId: account.id,
            sessionHandle: terminalTarget.handle,
            sessionApp: terminalTarget.app,
            toUserId: message.from_user_id,
            conversationId,
            chatType: messageMeta.chatType,
            senderUserId: messageMeta.senderUserId,
            groupId: messageMeta.groupId,
            sessionId: messageMeta.sessionId,
            contextToken: message.context_token,
            inboundText,
            inboundItems,
            messageId: message.message_id ?? null,
          });

          const promptText = buildInjectedPrompt({
            ticket,
            cliPath,
            nodePath,
          });

          const injection = await injectPromptIntoSession({
            terminalTarget,
            promptText,
            abortSignal,
          });

          updateTicket(ticket.id, {
            injectedAt: new Date().toISOString(),
            injection,
            promptText,
          });

          await sendTextMessage({
            accountId: account.id,
            baseUrl: account.baseUrl,
            token: account.token,
            toUserId: message.from_user_id,
            contextToken: message.context_token,
            text: `已转发到 Codex，会在完成后自动回传。ticket: ${ticket.id}`,
          });

          appendConversationHistory({
            accountId: account.id,
            conversationId,
            direction: "outbound",
            role: "router",
            text: `已转发到 Codex，会在完成后自动回传。ticket: ${ticket.id}`,
            chatType: messageMeta.chatType,
            ticketId: ticket.id,
            meta: {
              toUserId: message.from_user_id ?? null,
              senderUserId: messageMeta.senderUserId ?? null,
              groupId: messageMeta.groupId ?? null,
              sessionId: messageMeta.sessionId ?? null,
            },
          });

          appendEvent({
            type: "wechat.ticket.injected",
            accountId: account.id,
            conversationId,
            payload: {
              ticketId: ticket.id,
              sessionHandle: terminalTarget.handle,
              preview: truncateText(inboundText),
              injection,
            },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          appendEvent({
            type: "wechat.message.reply_failed",
            accountId: account.id,
            conversationId,
            payload: {
              preview: truncateText(inboundText),
              error: errorMessage,
              sessionHandle: terminalTarget.handle,
            },
          });

          if (message.context_token) {
            try {
              const failureText = `处理失败: ${errorMessage}`;
              await sendTextMessage({
                accountId: account.id,
                baseUrl: account.baseUrl,
                token: account.token,
                toUserId: message.from_user_id,
                contextToken: message.context_token,
                text: failureText,
              });
              appendConversationHistory({
                accountId: account.id,
                conversationId,
                direction: "outbound",
                role: "router",
                text: failureText,
                chatType: messageMeta.chatType,
                meta: {
                  toUserId: message.from_user_id ?? null,
                  senderUserId: messageMeta.senderUserId ?? null,
                  groupId: messageMeta.groupId ?? null,
                  sessionId: messageMeta.sessionId ?? null,
                },
              });
            } catch {
              // best effort
            }
          }
        }
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        break;
      }
      consecutiveFailures += 1;
      appendEvent({
        type: "bridge.monitor.error",
        accountId: account.id,
        payload: {
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures,
          sessionHandle: terminalTarget.handle,
        },
      });
      try {
        await sleep(
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
          abortSignal,
        );
      } catch {
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
      }
    }
  }

  appendEvent({
    type: "bridge.monitor.stopped",
    accountId: account.id,
    payload: {
      sessionHandle: terminalTarget.handle,
      mode: "session-ticket-reply",
    },
  });
}
