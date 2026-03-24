import process from "node:process";

import {
  resolveAgentAccountHistoryPath,
} from "./paths.mjs";
import {
  focusTerminalTarget,
  pressKeyOnTerminalTarget,
  resolveCurrentTerminalTarget,
  sendNativeTextToTerminalTarget,
  sendTextToTerminalTarget,
} from "./terminal-control.mjs";

const INPUT_FOCUS_DELAY_MS = 120;
const SUBMIT_FOCUS_DELAY_MS = 80;
const SUBMIT_KEYS = Object.freeze(["return", "enter"]);
const PROMPT_CLI_COMMAND = "weixin-agent";

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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildPromptCliPrefix() {
  return PROMPT_CLI_COMMAND;
}

function buildMediaReplyExample({
  cliPath = process.argv[1],
  nodePath = process.execPath,
  ticketId,
}) {
  return `${buildPromptCliPrefix()} reply --ticket ${shellQuote(ticketId)} --media /abs/path/to/file.png --message '说明文字'`;
}

function formatConversationMetaLines(ticket) {
  const lines = [];
  if (ticket?.chatType) {
    lines.push(`chat_type: ${ticket.chatType}`);
  }
  if (ticket?.conversationId) {
    lines.push(`conversation_id: ${ticket.conversationId}`);
  }
  if (ticket?.senderUserId && ticket.senderUserId !== ticket.toUserId) {
    lines.push(`sender_user: ${ticket.senderUserId}`);
  }
  if (ticket?.groupId) {
    lines.push(`group_id: ${ticket.groupId}`);
  }
  if (ticket?.sessionId) {
    lines.push(`weixin_session_id: ${ticket.sessionId}`);
  }
  return lines;
}

function formatInboundAttachmentLines(ticket) {
  const inboundItems = Array.isArray(ticket?.inboundItems) ? ticket.inboundItems : [];
  const attachments = inboundItems.filter((item) => item && item.type && item.type !== "text");
  if (attachments.length === 0) {
    return [];
  }

  return [
    "",
    "Inbound attachments:",
    ...attachments.map((item, index) => {
      const parts = [];
      if (item.fileName) {
        parts.push(`name=${item.fileName}`);
      }
      if (item.localPath) {
        parts.push(`local_path=${item.localPath}`);
      }
      if (item.mediaType) {
        parts.push(`media_type=${item.mediaType}`);
      }
      if (item.url) {
        parts.push(`url=${item.url}`);
      }
      if (item.text) {
        parts.push(`text=${item.text}`);
      }
      if (item.size) {
        parts.push(`size=${item.size}`);
      }
      if (item.width && item.height) {
        parts.push(`dimensions=${item.width}x${item.height}`);
      }
      if (item.playtime) {
        parts.push(`playtime_ms=${item.playtime}`);
      }
      if (item.playLength) {
        parts.push(`play_length_ms=${item.playLength}`);
      }
      if (item.sampleRate) {
        parts.push(`sample_rate=${item.sampleRate}`);
      }
      if (item.bitsPerSample) {
        parts.push(`bits_per_sample=${item.bitsPerSample}`);
      }
      if (item.encodeType) {
        parts.push(`encode_type=${item.encodeType}`);
      }
      if (item.md5) {
        parts.push(`md5=${item.md5}`);
      }
      if (item.sha256) {
        parts.push(`sha256=${item.sha256}`);
      }
      if (item.refMessage?.title || item.refMessage?.body) {
        const refParts = [item.refMessage.title, item.refMessage.body].filter(Boolean);
        parts.push(`ref=${refParts.join(" | ")}`);
      }
      if (item.encryptQueryParam) {
        parts.push(`encrypt_query_param=${String(item.encryptQueryParam).slice(0, 32)}...`);
      }
      if (item.hasAesKey) {
        parts.push("aes_key=yes");
      }
      if (item.downloadError) {
        parts.push(`download_error=${item.downloadError}`);
      }
      return `- ${item.type} #${index + 1}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
    }),
  ];
}

export function buildReplyCommand({
  cliPath = process.argv[1],
  nodePath = process.execPath,
  ticketId,
}) {
  return `${buildPromptCliPrefix()} reply --ticket ${shellQuote(ticketId)} --stdin`;
}

export function buildTransferCommand({
  cliPath = process.argv[1],
  nodePath = process.execPath,
  ticketId,
  targetNames,
}) {
  return `${buildPromptCliPrefix()} transfer --ticket ${shellQuote(ticketId)} --to ${shellQuote(targetNames)}`;
}

export function buildSpawnCommand({
  cliPath = process.argv[1],
  nodePath = process.execPath,
  kind,
  targetName,
}) {
  return `${buildPromptCliPrefix()} spawn ${shellQuote(kind)} --name ${shellQuote(targetName)}`;
}

export function buildRecoverCommand({
  cliPath = process.argv[1],
  nodePath = process.execPath,
  targetName,
}) {
  return `${buildPromptCliPrefix()} recover --name ${shellQuote(targetName)}`;
}

export function buildStablePromptCommand({
  cliPath = process.argv[1],
  nodePath = process.execPath,
}) {
  return `${buildPromptCliPrefix()} self prompt-stable`;
}

export function buildStableAgentPrompt({
  agentName,
  cliPath,
  nodePath,
}) {
  const recoverCommand = buildRecoverCommand({
    cliPath,
    nodePath,
    targetName: "<offline-agent>",
  });
  const spawnCodexCommand = buildSpawnCommand({
    cliPath,
    nodePath,
    kind: "codex",
    targetName: "<new-agent>",
  });
  const spawnClaudeCommand = buildSpawnCommand({
    cliPath,
    nodePath,
    kind: "claude",
    targetName: "<new-agent>",
  });
  const mediaReplyExample = buildMediaReplyExample({
    cliPath,
    nodePath,
    ticketId: "<ticket-id>",
  });
  const resolvedAgentName = typeof agentName === "string" && agentName.trim()
    ? agentName.trim()
    : "<current-agent>";

  return [
    "[Weixin Stable Prompt]",
    `agent: ${resolvedAgentName}`,
    "",
    "Stable rules:",
    `- You are currently acting as ${resolvedAgentName}.`,
    `- WeChat replies sent by reply --ticket will be automatically prefixed with [${resolvedAgentName}].`,
    "- Only a leading @agent-name has already been handled by the router as strict routing.",
    "- If the user message mentions another agent later in the body, treat that as semantic delegation unless the context clearly shows it is just literal text.",
    "- For inline mentions such as '@另一个智能体，你去做X', first extract the subtask that belongs to that agent instead of blindly forwarding the whole message.",
    "- If the inline-mentioned agent is online, transfer the ticket to that agent when appropriate.",
    "- If the inline-mentioned agent is offline but known, reopen it first with recover --name, then transfer when appropriate.",
    "- If the inline-mentioned agent does not exist, do not invent a result on its behalf; tell the user it does not exist or suggest creating it.",
    "- If the user message contains work for both you and another agent, first decompose the tasks, then handle your part and delegate the other part deliberately.",
    "- If this ticket should be handled by another connected agent instead of you, transfer it instead of replying from the wrong identity.",
    "- If the user explicitly asks to create or open another agent and provides a full unique display name, use spawn for that new agent.",
    "- spawn already opens a new terminal session, starts codex/claude there, and connects that new agent into the router.",
    "- If the user wants a new agent but has not chosen a full unique display name yet, ask for the name before spawning.",
    "- If spawn/recover fails because terminal automation or session resolution is unavailable, explain the environment issue first instead of pretending the new agent was created.",
    `- If the needed agent is currently offline, you can reopen it first: ${recoverCommand}`,
    `- To create a new Codex agent with an explicit name, use: ${spawnCodexCommand}`,
    `- To create a new Claude agent with an explicit name, use: ${spawnClaudeCommand}`,
    `- To send a local or remote image/file/video back to WeChat, use reply --ticket ... --media <path-or-url>. Example: ${mediaReplyExample}`,
    "- After a successful transfer, do not call reply for that ticket from this terminal.",
  ].join("\n");
}

export function buildInjectedPrompt({
  ticket,
  cliPath,
  nodePath,
}) {
  const replyCommand = buildReplyCommand({
    cliPath,
    nodePath,
    ticketId: ticket.id,
  });
  const singleTransferCommand = buildTransferCommand({
    cliPath,
    nodePath,
    ticketId: ticket.id,
    targetNames: "<target-agent>",
  });
  const multiTransferCommand = buildTransferCommand({
    cliPath,
    nodePath,
    ticketId: ticket.id,
    targetNames: "<target-a>,<target-b>",
  });
  const spawnCodexCommand = buildSpawnCommand({
    cliPath,
    nodePath,
    kind: "codex",
    targetName: "<new-agent>",
  });
  const recoverCommand = buildRecoverCommand({
    cliPath,
    nodePath,
    targetName: "<offline-agent>",
  });
  const mediaReplyExample = buildMediaReplyExample({
    cliPath,
    nodePath,
    ticketId: ticket.id,
  });
  const stablePromptCommand = buildStablePromptCommand({
    cliPath,
    nodePath,
  });
  const historyPath = resolveAgentAccountHistoryPath(ticket.accountId);

  const lines = [
    "[Weixin Ticket]",
    `ticket: ${ticket.id}`,
    `agent: ${ticket.agentName}`,
    `from_user: ${ticket.toUserId}`,
    ...formatConversationMetaLines(ticket),
  ];

  if (ticket.parentTicketId) {
    lines.push(`parent_ticket: ${ticket.parentTicketId}`);
  }
  if (ticket.transferSourceAgentName) {
    lines.push(`transferred_from: ${ticket.transferSourceAgentName}`);
  }

  lines.push(
    "",
    `history_jsonl: ${historyPath}`,
    `current_conversation_id: ${ticket.conversationId ?? ticket.toUserId}`,
    `stable_rules_command: ${stablePromptCommand}`,
    "",
    "User message:",
    ticket.inboundText,
    ...formatInboundAttachmentLines(ticket),
    "",
    "Tool commands:",
    `- spawn: ${spawnCodexCommand}`,
    `- transfer: ${singleTransferCommand.replace("<target-agent>", "<target-agent[,target-agent...]>")}`,
    `- recover: ${recoverCommand}`,
    `- media: ${mediaReplyExample}`,
    "",
    "Final reply command:",
    `cat <<'WXAGENT_REPLY' | ${replyCommand}`,
    "<replace this line with the final WeChat reply text>",
    "WXAGENT_REPLY",
  );

  return lines.join("\n");
}

export async function injectPromptIntoSession({
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

export async function resolveAgentTerminalTarget(agent) {
  if (!agent?.sessionHandle) {
    throw new Error(`Agent ${agent?.id ?? "unknown"} is missing sessionHandle.`);
  }

  return resolveCurrentTerminalTarget({
    app: agent.sessionApp ?? null,
    session: agent.sessionHandle,
  });
}
