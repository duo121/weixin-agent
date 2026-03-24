import fs from "node:fs";
import path from "node:path";

import { appendEvent } from "./events.mjs";
import { appendConversationHistory } from "./history.mjs";
import { resolveWeixinSyncBufPath } from "./paths.mjs";
import {
  isTerminalCaptureBusy,
  waitForTerminalTurnCompletion,
} from "./terminal-observer.mjs";
import { captureTerminalTarget, sendTextToTerminalTarget } from "./terminal-control.mjs";
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

export async function runWeixinBridge({
  account,
  sessionController,
  appServerReady = false,
  mode = "terminal-inject",
  terminalTarget = null,
  abortSignal,
}) {
  let getUpdatesBuf = loadSyncBuf(account.id);
  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  appendEvent({
    type: "bridge.monitor.started",
    accountId: account.id,
    payload: {
      threadId: sessionController.threadId,
      baseUrl: account.baseUrl,
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
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, abortSignal);
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

        const inboundText = extractInboundText(message);
        const messageMeta = extractWechatConversationMeta(message);
        const conversationId = messageMeta.conversationId;
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
          },
        });

        try {
          let result;
          if (mode === "terminal-inject") {
            const beforeCapture = await captureTerminalTarget(terminalTarget);
            if (isTerminalCaptureBusy(beforeCapture)) {
              throw new Error("当前 Codex 会话正在处理另一条消息，请稍后重试。");
            }

            let canUseAppServer = appServerReady;
            let snapshot = null;
            if (canUseAppServer) {
              try {
                snapshot = await sessionController.getThreadSnapshot();
                if (!snapshot.idle) {
                  throw new Error("当前 Codex 会话正在处理另一条消息，请稍后重试。");
                }
              } catch (error) {
                canUseAppServer = false;
                appendEvent({
                  type: "codex.app_server.observe_failed",
                  accountId: account.id,
                  conversationId: message.from_user_id ?? null,
                  payload: {
                    threadId: sessionController.threadId,
                    phase: "preflight",
                    error: error instanceof Error ? error.message : String(error),
                  },
                });
              }
            }

            await sendTextToTerminalTarget(terminalTarget, inboundText, {
              newline: true,
            });

            appendEvent({
              type: "codex.terminal.injected",
              accountId: account.id,
              conversationId: message.from_user_id ?? null,
              payload: {
                threadId: sessionController.threadId,
                terminal: terminalTarget
                  ? {
                      app: terminalTarget.app,
                      sessionId: terminalTarget.sessionId,
                      handle: terminalTarget.handle,
                    }
                  : null,
                preview: truncateText(inboundText),
              },
            });

            let terminalResult = null;
            let terminalError = null;
            let appServerResult = null;
            let appServerError = null;

            const terminalObservation = waitForTerminalTurnCompletion({
              terminalTarget,
              beforeText: beforeCapture,
              abortSignal,
            });

            const appServerObservation = canUseAppServer
              ? sessionController.waitForNextCompletedTurn({
                  afterTurnCount: snapshot?.turnCount ?? 0,
                  expectedUserText: inboundText,
                }).then((value) => {
                  appServerResult = value;
                  return value;
                }).catch((error) => {
                  appServerError = error;
                  return null;
                })
              : null;

            try {
              terminalResult = await terminalObservation;
            } catch (error) {
              terminalError = error;
            }

            if (appServerObservation) {
              if (terminalResult) {
                await Promise.race([
                  appServerObservation,
                  sleep(1_000, abortSignal).catch(() => null),
                ]);
              } else {
                await appServerObservation;
              }
            }

            if (appServerError) {
              appendEvent({
                type: "codex.app_server.observe_failed",
                accountId: account.id,
                conversationId: message.from_user_id ?? null,
                payload: {
                  threadId: sessionController.threadId,
                  error: appServerError instanceof Error ? appServerError.message : String(appServerError),
                },
              });
            }

            if (!appServerResult && !terminalResult) {
              throw terminalError ?? appServerError ?? new Error("无法从终端或 app-server 读取这轮回复。");
            }

            result = appServerResult ?? {
              threadId: sessionController.threadId,
              turnId: null,
              text: terminalResult?.text ?? "",
              source: terminalResult?.source ?? "terminal-capture",
              captureText: terminalResult?.captureText ?? null,
              busySeen: terminalResult?.busySeen ?? false,
            };

            if (!result.text && terminalResult.text) {
              result.text = terminalResult.text;
            }

            if (!result.text) {
              result.text = "任务已完成，请查看终端中的完整输出。";
            }
          } else {
            if (!appServerReady) {
              throw new Error("direct-thread 模式要求 Codex app-server thread 已可恢复。");
            }

            result = await sessionController.sendTextTurn(inboundText);
          }
          const replyText = result.text || "任务已完成，但没有文本输出。";

          if (message.context_token) {
            await sendTextMessage({
              accountId: account.id,
              baseUrl: account.baseUrl,
              token: account.token,
              toUserId: message.from_user_id,
              contextToken: message.context_token,
              text: replyText,
            });

            appendConversationHistory({
              accountId: account.id,
              conversationId,
              direction: "outbound",
              role: "agent",
              text: replyText,
              chatType: messageMeta.chatType,
              meta: {
                toUserId: message.from_user_id ?? null,
                senderUserId: messageMeta.senderUserId ?? null,
                groupId: messageMeta.groupId ?? null,
                sessionId: messageMeta.sessionId ?? null,
              },
            });
          }

          appendEvent({
            type: "wechat.message.replied",
            accountId: account.id,
            conversationId,
            payload: {
              threadId: result.threadId,
              turnId: result.turnId,
              preview: truncateText(replyText),
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
        },
      });
      try {
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, abortSignal);
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
      threadId: sessionController.threadId,
    },
  });
}
