import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  findAgentByDisplayName,
  findLatestAgentByDisplayName,
  listAgents,
  normalizeExplicitAgentDisplayName,
  setAgentTicket,
  updateAgent,
} from "./agents.mjs";
import { removeAgentsByDisplayName } from "./agent-service.mjs";
import {
  loadConversationRoute,
  setConversationLastAgent,
  setConversationRouterReplyEnabled,
} from "./conversations.mjs";
import { appendEvent } from "./events.mjs";
import { appendConversationHistory } from "./history.mjs";
import { resolveWeixinSyncBufPath } from "./paths.mjs";
import {
  buildInjectedPrompt,
  injectPromptIntoSession,
  resolveAgentTerminalTarget,
} from "./ticket-prompt.mjs";
import { createTicket, listPendingTicketsForAgent, updateTicket } from "./tickets.mjs";
import { ensureOnDemandAgent, recoverAgentSession, spawnAgentSession } from "./spawn-service.mjs";
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

function formatRelativeTime(timestamp) {
  const millis = Date.now() - (Date.parse(timestamp ?? "") || 0);
  if (!Number.isFinite(millis) || millis < 0) {
    return "";
  }

  const seconds = Math.floor(millis / 1000);
  if (seconds < 60) {
    return `${seconds}s前`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h前`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d前`;
}

function collapseAgentsByDisplayName(agents) {
  const byName = new Map();
  for (const agent of agents) {
    const key = String(agent?.displayName ?? "").trim();
    if (!key) {
      continue;
    }
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, agent);
      continue;
    }
    const existingTime = Date.parse(existing.connectedAt ?? existing.createdAt ?? existing.lastSeenAt ?? "") || 0;
    const currentTime = Date.parse(agent.connectedAt ?? agent.createdAt ?? agent.lastSeenAt ?? "") || 0;
    if (currentTime >= existingTime) {
      byName.set(key, agent);
    }
  }
  return [...byName.values()].sort((left, right) =>
    String(left.displayName ?? "").localeCompare(String(right.displayName ?? "")));
}

function parseSlashCommand(text) {
  const raw = String(text ?? "");
  const match = raw.match(/^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return null;
  }
  return {
    command: match[1].toLowerCase(),
    args: String(match[2] ?? "").trim(),
  };
}

function buildCompactAgentsText({
  agents,
  route = null,
}) {
  const uniqueAgents = collapseAgentsByDisplayName(agents);
  if (uniqueAgents.length === 0) {
    return "暂无智能体";
  }

  const lines = [`智能体 ${uniqueAgents.length}`];
  if (route?.lastAgentName) {
    lines.push(`当前 ${route.lastAgentName}`);
  }

  for (const agent of uniqueAgents) {
    const pendingCount = listPendingTicketsForAgent(agent.id).length;
    const availability = agent.live ? "在线" : "离线";
    const workload = pendingCount > 0 || agent.currentTicketId ? `忙${pendingCount > 0 ? `x${pendingCount}` : ""}` : "闲";
    const ageText = !agent.live
      ? formatRelativeTime(agent.disconnectedAt ?? agent.lastSeenAt ?? agent.updatedAt ?? agent.createdAt)
      : "";
    lines.push([
      agent.displayName,
      availability,
      workload,
      ageText,
    ].filter(Boolean).join(" "));
  }

  return lines.join("\n");
}

function parseLeadingMentionRoute(text) {
  const trimmed = String(text ?? "").trim();
  const mentions = [];
  let rest = trimmed;

  while (rest.startsWith("@")) {
    const match = rest.match(/^@([^\s]+)(?:\s+|$)/u);
    if (!match) {
      break;
    }
    const mention = String(match[1] ?? "").trim().replace(/^@+/u, "");
    if (!mention) {
      break;
    }
    if (!mentions.includes(mention)) {
      mentions.push(mention);
    }
    rest = rest.slice(match[0].length).trimStart();
  }

  return {
    mentions,
    body: mentions.length > 0 ? rest.trim() : trimmed,
  };
}

function buildAgentListText(agents, {
  header,
  includeExample = true,
} = {}) {
  const lines = [header];
  if (agents.length === 0) {
    return lines.join("\n");
  }

  lines.push("");
  lines.push("在线智能体：");
  for (const agent of agents) {
    lines.push(`- @${agent.displayName} (${agent.kind}, ${agent.currentTicketId ? "busy" : "idle"})`);
  }

  if (includeExample) {
    lines.push("");
    lines.push(`示例：@${agents[0].displayName} 帮我查看一下当前项目状态`);
  }

  return lines.join("\n");
}

function formatMentionNames(mentions, separator = "、") {
  return mentions.map((mention) => `@${mention}`).join(separator);
}

function isRouterReplyEnabled(route) {
  return route?.routerReplyEnabled === true;
}

function buildRouterReplyStatusText(route) {
  return isRouterReplyEnabled(route) ? "已开启" : "已关闭";
}

function buildHelpText(route) {
  return [
    "可用命令：",
    "/help 查看帮助",
    "/agents 或 /agn 查看智能体列表",
    "/new 名字 创建或重新连接智能体",
    "/rm 名字 删除智能体",
    "/router status 查看当前会话的 router 调试回复状态",
    "/router on 开启当前会话的 router 调试回复",
    "/router off 关闭当前会话的 router 调试回复",
    "",
    "路由规则：",
    "- 以单个 @名字 开头：切换到该智能体；如果后面还有正文，这条消息也会交给它",
    "- 以多个 @名字 开头：只对当前这条消息做多智能体调用，并把第一个名字设为当前智能体",
    "- 不以 @名字 开头：继续使用这个微信会话当前的默认目标",
    "",
    `当前会话的 router 调试回复：${buildRouterReplyStatusText(route)}`,
  ].join("\n");
}

async function handleSlashCommand({
  command,
  args,
  account,
  message,
  inboundText,
}) {
  const { conversationId } = extractWechatConversationMeta(message);

  if (command === "help") {
    const route = loadConversationRoute({
      accountId: account.id,
      conversationId,
    });
    await sendWechatTextReply({
      account,
      message,
      text: buildHelpText(route),
    });
    appendEvent({
      type: "wechat.command.help",
      accountId: account.id,
      conversationId,
      payload: {
        preview: truncateText(inboundText),
      },
    });
    return { handled: true };
  }

  if (command === "router") {
    const action = String(args ?? "").trim().toLowerCase();
    if (!action || action === "status") {
      const route = loadConversationRoute({
        accountId: account.id,
        conversationId,
      });
      await sendWechatTextReply({
        account,
        message,
        text: `当前会话的 router 调试回复：${buildRouterReplyStatusText(route)}`,
      });
      appendEvent({
        type: "wechat.command.router",
        accountId: account.id,
        conversationId,
        payload: {
          preview: truncateText(inboundText),
          action: action || "status",
          enabled: isRouterReplyEnabled(route),
        },
      });
      return { handled: true };
    }

    if (action !== "on" && action !== "off") {
      await sendWechatTextReply({
        account,
        message,
        text: "用法: /router on|off|status",
      });
      return { handled: true };
    }

    const enabled = action === "on";
    const route = setConversationRouterReplyEnabled({
      accountId: account.id,
      conversationId,
      enabled,
    });
    await sendWechatTextReply({
      account,
      message,
      text: `当前会话的 router 调试回复已${enabled ? "开启" : "关闭"}。`,
    });
    appendEvent({
      type: "wechat.command.router",
      accountId: account.id,
      conversationId,
      payload: {
        preview: truncateText(inboundText),
        action,
        enabled: isRouterReplyEnabled(route),
      },
    });
    return { handled: true };
  }

  if (command === "agn" || command === "agents") {
    const route = loadConversationRoute({
      accountId: account.id,
      conversationId,
    });
    await sendWechatTextReply({
      account,
      message,
      text: buildCompactAgentsText({
        agents: listAgents(),
        route,
      }),
    });
    appendEvent({
      type: "wechat.command.agents",
      accountId: account.id,
      conversationId,
      payload: {
        preview: truncateText(inboundText),
      },
    });
    return { handled: true };
  }

  if (command === "new") {
    if (!args) {
      await sendWechatTextReply({
        account,
        message,
        text: "用法: /new 名字",
      });
      return { handled: true };
    }

    const displayName = normalizeExplicitAgentDisplayName(args);
    try {
      const knownAgent = findLatestAgentByDisplayName(displayName, { onlyLive: false });
      if (knownAgent?.live) {
        await sendWechatTextReply({
          account,
          message,
          text: `${displayName} 已在线`,
        });
        return { handled: true };
      }

      if (knownAgent) {
        const recovered = await recoverAgentSession({
          displayName,
          reason: "router.slash_new_recover",
        });
        await sendWechatTextReply({
          account,
          message,
          text: `${recovered.agent.displayName} 已重新连接`,
        });
        return { handled: true };
      }

      const spawned = await spawnAgentSession({
        requestedName: displayName,
        kind: "codex",
        cwd: process.cwd(),
        autoNameAllowed: false,
        reason: "router.slash_new",
      });
      await sendWechatTextReply({
        account,
        message,
        text: `${spawned.agent.displayName} 已创建`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await sendWechatTextReply({
        account,
        message,
        text: `创建失败: ${errorMessage}`,
      });
    }
    return { handled: true };
  }

  if (command === "rm" || command === "remove") {
    if (!args) {
      await sendWechatTextReply({
        account,
        message,
        text: "用法: /rm 名字",
      });
      return { handled: true };
    }

    const displayName = normalizeExplicitAgentDisplayName(args);
    try {
      const result = removeAgentsByDisplayName(displayName, {
        force: true,
      });
      await sendWechatTextReply({
        account,
        message,
        text: `已删除 ${displayName}${result.removedCount > 1 ? ` (${result.removedCount})` : ""}`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await sendWechatTextReply({
        account,
        message,
        text: `删除失败: ${errorMessage}`,
      });
    }
    return { handled: true };
  }

  return { handled: false };
}

function pickFirstConnectedAgent(agents) {
  const ranked = [...agents].sort((left, right) => {
    const leftTime = Date.parse(left.connectedAt ?? left.createdAt ?? left.lastSeenAt ?? "") || 0;
    const rightTime = Date.parse(right.connectedAt ?? right.createdAt ?? right.lastSeenAt ?? "") || 0;
    return leftTime - rightTime;
  });
  return ranked[0] ?? null;
}

function buildSwitchCurrentAgentText(agentName) {
  return `以后由 @${agentName} 来回复你的问题。`;
}

function resolveRoutingDecision({
  accountId,
  conversationId,
  inboundText,
  agents,
}) {
  const trimmedText = String(inboundText ?? "").trim();
  const mentionRoute = parseLeadingMentionRoute(inboundText);
  if (mentionRoute.mentions.length > 0) {
    if (mentionRoute.mentions.length === 1 && !mentionRoute.body) {
      const liveAgent = findAgentByDisplayName(mentionRoute.mentions[0], { onlyLive: true });
      if (liveAgent) {
        return {
          kind: "switch_current",
          nextCurrentAgent: liveAgent,
          replyText: buildSwitchCurrentAgentText(liveAgent.displayName),
          routeSource: "explicit-mention-switch",
        };
      }

      const knownAgent = findLatestAgentByDisplayName(mentionRoute.mentions[0], { onlyLive: false });
      if (knownAgent) {
        return {
          kind: "offline_switch",
          agentName: mentionRoute.mentions[0],
          routeSource: "explicit-mention-switch",
        };
      }
      return {
        kind: "missing_agent",
        replyText: buildAgentListText(agents, {
          header: `没有找到名为 @${mentionRoute.mentions[0]} 的已知智能体。可用 /new ${mentionRoute.mentions[0]} 创建。`,
        }),
      };
    }

    if (!mentionRoute.body) {
      return {
        kind: "missing_body",
        replyText: buildAgentListText(agents, {
          header: `请在 ${formatMentionNames(mentionRoute.mentions, " ")} 后面带上消息内容。`,
        }),
      };
    }

    const liveAgents = [];
    const offlineAgentNames = [];
    const missingAgentNames = [];

    for (const mention of mentionRoute.mentions) {
      const liveAgent = findAgentByDisplayName(mention, { onlyLive: true });
      if (liveAgent) {
        liveAgents.push(liveAgent);
        continue;
      }
      const knownAgent = findLatestAgentByDisplayName(mention, { onlyLive: false });
      if (knownAgent) {
        offlineAgentNames.push(mention);
        continue;
      }
      missingAgentNames.push(mention);
    }

    if (missingAgentNames.length > 0) {
      const header = missingAgentNames.length === 1
        ? `没有找到名为 ${formatMentionNames(missingAgentNames)} 的已知智能体。可用 /new ${missingAgentNames[0]} 创建。`
        : `没有找到这些已知智能体：${formatMentionNames(missingAgentNames)}。请先分别创建。`;
      return {
        kind: "missing_agent",
        replyText: buildAgentListText(agents, {
          header,
        }),
      };
    }

    if (offlineAgentNames.length > 0) {
      if (mentionRoute.mentions.length === 1) {
        return {
          kind: "offline_target",
          agentName: mentionRoute.mentions[0],
          content: mentionRoute.body,
          routeSource: "explicit-mention",
        };
      }
      return {
        kind: "offline_targets",
        agentNames: offlineAgentNames,
        liveAgents,
        allAgentNames: mentionRoute.mentions,
        content: mentionRoute.body,
        routeSource: "explicit-mention-multi",
      };
    }

    return {
      kind: mentionRoute.mentions.length === 1 ? "targeted" : "targeted_multi",
      agents: liveAgents,
      content: mentionRoute.body,
      routeSource: mentionRoute.mentions.length === 1 ? "explicit-mention" : "explicit-mention-multi",
      nextCurrentAgent: liveAgents[0] ?? null,
    };
  }

  if (agents.length === 0) {
    return {
      kind: "no_agents",
      replyText: "当前没有在线智能体。请先在某个终端里运行 `weixin-agent connect --session ...`。",
    };
  }

  const memory = loadConversationRoute({
    accountId,
    conversationId,
  });

  if (memory?.lastAgentId) {
    const rememberedAgent = agents.find((agent) => agent.id === memory.lastAgentId) ?? null;
    if (rememberedAgent) {
      return {
        kind: "default_current",
        agents: [rememberedAgent],
        content: trimmedText,
        routeSource: "current-conversation",
      };
    }
  }

  if (memory?.lastAgentName) {
    const rememberedAgentByName = agents.find((agent) => agent.displayName === memory.lastAgentName) ?? null;
    if (rememberedAgentByName) {
      return {
        kind: "default_current",
        agents: [rememberedAgentByName],
        content: trimmedText,
        routeSource: "current-conversation-name-match",
      };
    }

    return {
      kind: "offline_current",
      agentName: memory.lastAgentName,
      content: trimmedText,
      routeSource: "current-conversation",
    };
  }

  const fallbackAgent = pickFirstConnectedAgent(agents);
  if (fallbackAgent) {
    return {
      kind: "default_seed",
      agents: [fallbackAgent],
      content: trimmedText,
      routeSource: "first-connected-agent",
      nextCurrentAgent: fallbackAgent,
    };
  }

  return {
    kind: "no_agents",
    replyText: "当前没有可用的在线智能体。",
  };
}

async function sendWechatTextReply({
  account,
  message,
  text,
  role = "router",
  agentId = null,
  agentName = null,
  ticketId = null,
  parentTicketId = null,
  items = [],
}) {
  if (!message.context_token) {
    return;
  }

  const replyText = String(text ?? "").trim();
  if (!replyText) {
    throw new Error("WeChat reply text is empty.");
  }

  await sendTextMessage({
    accountId: account.id,
    baseUrl: account.baseUrl,
    token: account.token,
    toUserId: message.from_user_id,
    contextToken: message.context_token,
    text: replyText,
  });

  const messageMeta = extractWechatConversationMeta(message);
  appendConversationHistory({
    accountId: account.id,
    conversationId: messageMeta.conversationId,
    direction: "outbound",
    role,
    text: replyText,
    items,
    chatType: messageMeta.chatType,
    agentId,
    agentName,
    ticketId,
    parentTicketId,
    meta: {
      toUserId: message.from_user_id ?? null,
      senderUserId: messageMeta.senderUserId ?? null,
      groupId: messageMeta.groupId ?? null,
      sessionId: messageMeta.sessionId ?? null,
    },
  });
}

async function createAndInjectTicketForAgent({
  account,
  message,
  agent,
  inboundText,
  inboundItems,
  routeSource,
  cliPath,
  nodePath,
  abortSignal,
}) {
  const terminalTarget = await resolveAgentTerminalTarget(agent);
  const messageMeta = extractWechatConversationMeta(message);
  const ticket = createTicket({
    accountId: account.id,
    agentId: agent.id,
    agentName: agent.displayName,
    sessionHandle: terminalTarget.handle,
    sessionApp: terminalTarget.app,
    toUserId: message.from_user_id,
    conversationId: messageMeta.conversationId,
    chatType: messageMeta.chatType,
    senderUserId: messageMeta.senderUserId,
    groupId: messageMeta.groupId,
    sessionId: messageMeta.sessionId,
    contextToken: message.context_token,
    inboundText,
    inboundItems,
    messageId: message.message_id ?? null,
    routeSource,
  });

  setAgentTicket(agent.id, ticket.id);

  const promptText = buildInjectedPrompt({
    ticket,
    cliPath,
    nodePath,
  });

  let injection = null;
  try {
    injection = await injectPromptIntoSession({
      terminalTarget,
      promptText,
      abortSignal,
    });
  } catch (injectError) {
    const errorMessage = injectError instanceof Error ? injectError.message : String(injectError);
    updateTicket(ticket.id, {
      status: "failed",
      failedAt: new Date().toISOString(),
      errorMessage,
      promptText,
    });
    setAgentTicket(agent.id, null);
    throw injectError;
  }

  const nextTicket = updateTicket(ticket.id, {
    injectedAt: new Date().toISOString(),
    injection,
    promptText,
  }) ?? ticket;

  updateAgent(agent.id, {
    target: terminalTarget,
  });

  return {
    agent,
    ticket: nextTicket,
    terminalTarget,
    injection,
  };
}

export async function runWeixinRouter({
  account,
  abortSignal,
  cliPath = process.argv[1],
  nodePath = process.execPath,
}) {
  let getUpdatesBuf = loadSyncBuf(account.id);
  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  appendEvent({
    type: "router.monitor.started",
    accountId: account.id,
    payload: {
      mode: "multi-agent-router",
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
          type: "router.monitor.api_error",
          accountId: account.id,
          payload: {
            ret: response.ret ?? null,
            errcode: response.errcode ?? null,
            errmsg: response.errmsg ?? null,
            consecutiveFailures,
          },
        });
        await sleep(
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS,
          abortSignal,
        );
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
        let agents = listAgents({ onlyLive: true });

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
            onlineAgents: agents.map((agent) => agent.displayName),
          },
        });

        try {
          if (!message.context_token) {
            throw new Error("Inbound WeChat message is missing context_token, cannot create a reply ticket.");
          }

          const slashCommand = parseSlashCommand(inboundText);
          if (slashCommand) {
            const result = await handleSlashCommand({
              command: slashCommand.command,
              args: slashCommand.args,
              account,
              message,
              inboundText,
            });
            if (result.handled) {
              continue;
            }
          }

          const mentionRoute = parseLeadingMentionRoute(inboundText);
          if (agents.length === 0 && mentionRoute.mentions.length === 0) {
            const memory = loadConversationRoute({
              accountId: account.id,
              conversationId,
            });
            try {
              const spawned = await ensureOnDemandAgent({
                requestedName: memory?.lastAgentName ?? null,
                cwd: process.cwd(),
              });
              if (spawned?.agent) {
                agents = [spawned.agent];
                appendEvent({
                  type: "router.auto_spawn.succeeded",
                  accountId: account.id,
                  conversationId,
                  payload: {
                    agentId: spawned.agent.id,
                    agentName: spawned.agent.displayName,
                    reused: Boolean(spawned.reused),
                    triggerPreview: truncateText(inboundText),
                  },
                });
              }
            } catch (spawnError) {
              const errorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
              appendEvent({
                type: "router.auto_spawn.failed",
                accountId: account.id,
                conversationId,
                payload: {
                  triggerPreview: truncateText(inboundText),
                  error: errorMessage,
                },
              });
              await sendWechatTextReply({
                account,
                message,
                text: `当前没有在线智能体，自动拉起默认智能体失败：${errorMessage}`,
              });
              continue;
            }
          }

          const routing = resolveRoutingDecision({
            accountId: account.id,
            conversationId,
            inboundText,
            agents,
          });
          let effectiveRouting = routing;
          if (
            routing.kind === "offline_target"
            || routing.kind === "offline_current"
            || routing.kind === "offline_switch"
            || routing.kind === "offline_targets"
          ) {
            try {
              if (routing.kind === "offline_targets") {
                const recoveredByName = new Map();
                for (const agentName of routing.agentNames) {
                  const recovered = await recoverAgentSession({
                    displayName: agentName,
                    reason: "router.recover_explicit_mentions",
                  });
                  recoveredByName.set(agentName, recovered.agent);
                  appendEvent({
                    type: "router.agent.recovered",
                    accountId: account.id,
                    conversationId,
                    payload: {
                      requestedName: agentName,
                      recoveredAgentId: recovered.agent?.id ?? null,
                      recoveredAgentName: recovered.agent?.displayName ?? null,
                      previousAgentId: recovered.previousAgent?.id ?? null,
                      reason: routing.kind,
                    },
                  });
                }

                const mergedAgents = routing.allAgentNames
                  .map((agentName) =>
                    recoveredByName.get(agentName)
                    ?? routing.liveAgents.find((agent) => agent.displayName === agentName)
                    ?? null)
                  .filter(Boolean);

                effectiveRouting = {
                  kind: "targeted_multi",
                  agents: mergedAgents,
                  content: routing.content,
                  routeSource: "explicit-mention-multi-recovered",
                  nextCurrentAgent: mergedAgents[0] ?? null,
                };
              } else {
                const recovered = await recoverAgentSession({
                  displayName: routing.agentName,
                  reason: routing.kind === "offline_target" || routing.kind === "offline_switch"
                    ? "router.recover_explicit_mention"
                    : "router.recover_current_agent",
                });
                effectiveRouting = routing.kind === "offline_switch"
                  ? {
                      kind: "switch_current",
                      nextCurrentAgent: recovered.agent,
                      replyText: buildSwitchCurrentAgentText(recovered.agent.displayName),
                      routeSource: "explicit-mention-switch-recovered",
                    }
                  : {
                      kind: routing.kind === "offline_target" ? "targeted" : "default_current",
                      agents: [recovered.agent],
                      content: routing.content,
                      routeSource: routing.kind === "offline_target"
                        ? "explicit-mention-recovered"
                        : "current-conversation-recovered",
                      nextCurrentAgent: recovered.agent,
                    };
                appendEvent({
                  type: "router.agent.recovered",
                  accountId: account.id,
                  conversationId,
                  payload: {
                    requestedName: routing.agentName,
                    recoveredAgentId: recovered.agent?.id ?? null,
                    recoveredAgentName: recovered.agent?.displayName ?? null,
                    previousAgentId: recovered.previousAgent?.id ?? null,
                    reason: routing.kind,
                  },
                });
              }
            } catch (recoverError) {
              const errorMessage = recoverError instanceof Error ? recoverError.message : String(recoverError);
              const header = routing.kind === "offline_target" || routing.kind === "offline_switch"
                ? `${formatMentionNames([routing.agentName])} 当前不在线，自动重拉失败：${errorMessage}`
                : routing.kind === "offline_targets"
                  ? `${formatMentionNames(routing.agentNames)} 当前不在线，自动重拉失败：${errorMessage}`
                  : `当前智能体 ${formatMentionNames([routing.agentName])} 不在线，自动重拉失败：${errorMessage}`;
              await sendWechatTextReply({
                account,
                message,
                text: buildAgentListText(agents, {
                  header,
                  includeExample: routing.kind === "offline_target" || routing.kind === "offline_switch",
                }),
              });
              appendEvent({
                type: "router.agent.recover_failed",
                accountId: account.id,
                conversationId,
                payload: {
                  requestedName: routing.agentName ?? null,
                  requestedNames: routing.agentNames ?? null,
                  reason: routing.kind,
                  error: errorMessage,
                },
              });
              continue;
            }
          }

          if (effectiveRouting.kind === "switch_current") {
            const nextCurrentAgent = effectiveRouting.nextCurrentAgent ?? null;
            if (nextCurrentAgent) {
              setConversationLastAgent({
                accountId: account.id,
                conversationId,
                agentId: nextCurrentAgent.id,
                agentName: nextCurrentAgent.displayName,
                source: effectiveRouting.routeSource ?? effectiveRouting.kind,
              });
            }
            await sendWechatTextReply({
              account,
              message,
              text: effectiveRouting.replyText,
            });
            appendEvent({
              type: "wechat.conversation.agent_switched",
              accountId: account.id,
              conversationId,
              payload: {
                preview: truncateText(inboundText),
                agentId: nextCurrentAgent?.id ?? null,
                agentName: nextCurrentAgent?.displayName ?? null,
              },
            });
            continue;
          }

          let targetAgents = Array.isArray(effectiveRouting.agents) ? effectiveRouting.agents : [];
          if (targetAgents.length === 0) {
            const fallbackContent = String(effectiveRouting.content ?? inboundText ?? "").trim();
            const fallbackAgent = pickFirstConnectedAgent(agents);
            if (!String(effectiveRouting.replyText ?? "").trim() && fallbackAgent && fallbackContent) {
              effectiveRouting = {
                kind: "fallback_online_agent",
                agents: [fallbackAgent],
                content: fallbackContent,
                routeSource: "fallback-online-agent",
                nextCurrentAgent: fallbackAgent,
              };
              targetAgents = [fallbackAgent];
            }
          }

          if (targetAgents.length === 0) {
            await sendWechatTextReply({
              account,
              message,
              text: effectiveRouting.replyText,
            });
            appendEvent({
              type: "wechat.message.routed_info",
              accountId: account.id,
              conversationId,
              payload: {
                preview: truncateText(inboundText),
                routingKind: effectiveRouting.kind,
              },
            });
            continue;
          }

          const successes = [];
          const failures = [];
          for (const agent of targetAgents) {
            try {
              const injected = await createAndInjectTicketForAgent({
                account,
                message,
                agent,
                inboundText: effectiveRouting.content,
                inboundItems,
                routeSource: effectiveRouting.routeSource ?? effectiveRouting.kind,
                cliPath,
                nodePath,
                abortSignal,
              });
              successes.push(injected);
              appendEvent({
                type: "wechat.ticket.injected",
                accountId: account.id,
                conversationId,
                payload: {
                  ticketId: injected.ticket.id,
                  agentId: injected.agent.id,
                  agentName: injected.agent.displayName,
                  sessionHandle: injected.terminalTarget.handle,
                  preview: truncateText(effectiveRouting.content),
                  injection: injected.injection,
                },
              });
            } catch (injectError) {
              failures.push({
                agent,
                error: injectError instanceof Error ? injectError.message : String(injectError),
              });
            }
          }

          if (successes.length === 0) {
            throw new Error(
              failures.length === 1
                ? `转发给 @${failures[0].agent.displayName} 失败：${failures[0].error}`
                : `转发给这些智能体失败：${failures.map((item) => `@${item.agent.displayName}`).join("、")}`,
            );
          }

          const nextCurrentAgent = effectiveRouting.nextCurrentAgent ?? null;
          if (nextCurrentAgent && successes.some((item) => item.agent.id === nextCurrentAgent.id)) {
            const currentTicket = successes.find((item) => item.agent.id === nextCurrentAgent.id)?.ticket ?? null;
            setConversationLastAgent({
              accountId: account.id,
              conversationId,
              agentId: nextCurrentAgent.id,
              agentName: nextCurrentAgent.displayName,
              ticketId: currentTicket?.id ?? null,
              source: effectiveRouting.routeSource ?? effectiveRouting.kind,
            });
          }

          const conversationRoute = loadConversationRoute({
            accountId: account.id,
            conversationId,
          });
          if (failures.length > 0) {
            try {
              const successText = `已转发给 ${formatMentionNames(successes.map((item) => item.agent.displayName))}`;
              const failureText = failures
                .map((item) => `@${item.agent.displayName} 转发失败：${item.error}`)
                .join("\n");
              await sendWechatTextReply({
                account,
                message,
                text: `${successText}\n${failureText}`,
              });
            } catch (ackError) {
              appendEvent({
                type: "wechat.ticket.ack_failed",
                accountId: account.id,
                conversationId,
                payload: {
                  ticketIds: successes.map((item) => item.ticket.id),
                  agentIds: successes.map((item) => item.agent.id),
                  failedAgentNames: failures.map((item) => item.agent.displayName),
                  error: ackError instanceof Error ? ackError.message : String(ackError),
                },
              });
            }
          } else if (isRouterReplyEnabled(conversationRoute)) {
            try {
              const ackText = successes.length === 1
                ? `已转发给 @${successes[0].agent.displayName}，完成后会自动回传。ticket: ${successes[0].ticket.id}`
                : `已转发给 ${formatMentionNames(successes.map((item) => item.agent.displayName))}，完成后会自动回传。`;
              await sendWechatTextReply({
                account,
                message,
                text: ackText,
              });
            } catch (ackError) {
              appendEvent({
                type: "wechat.ticket.ack_failed",
                accountId: account.id,
                conversationId,
                payload: {
                  ticketIds: successes.map((item) => item.ticket.id),
                  agentIds: successes.map((item) => item.agent.id),
                  error: ackError instanceof Error ? ackError.message : String(ackError),
                },
              });
            }
          }
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
              await sendWechatTextReply({
                account,
                message,
                text: `处理失败: ${errorMessage}`,
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
        type: "router.monitor.error",
        accountId: account.id,
        payload: {
          error: error instanceof Error ? error.message : String(error),
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
    }
  }

  appendEvent({
    type: "router.monitor.stopped",
    accountId: account.id,
    payload: {
      mode: "multi-agent-router",
    },
  });
}
