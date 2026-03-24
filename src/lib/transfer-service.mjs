import { findAgentByDisplayName, findAgentBySessionHandle, setAgentTicket, updateAgent } from "./agents.mjs";
import { appendEvent } from "./events.mjs";
import { CLIError } from "./errors.mjs";
import {
  buildInjectedPrompt,
  injectPromptIntoSession,
  resolveAgentTerminalTarget,
} from "./ticket-prompt.mjs";
import { isTerminalCaptureBusy } from "./terminal-observer.mjs";
import { captureTerminalTarget } from "./terminal-control.mjs";
import { createTicket, listPendingTicketsForAgent, loadTicket, updateTicket } from "./tickets.mjs";

function normalizeTransferTargets(rawTargets) {
  const values = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  const deduped = new Set();

  for (const value of values) {
    const parts = String(value ?? "")
      .split(/[,\uFF0C\u3001\n]/u)
      .map((item) => item.trim())
      .filter(Boolean);

    for (const part of parts) {
      deduped.add(part);
    }
  }

  return [...deduped];
}

async function ensureTransferTargetReady(targetAgent, parentTicketId) {
  const pendingTickets = listPendingTicketsForAgent(targetAgent.id)
    .filter((ticket) => ticket.id !== parentTicketId);
  if (pendingTickets.length > 0 || targetAgent.currentTicketId) {
    throw new CLIError("TRANSFER_TARGET_BUSY", `Agent ${targetAgent.displayName} 当前还有未完成任务。`, {
      agentId: targetAgent.id,
      agentName: targetAgent.displayName,
      pendingTicketIds: pendingTickets.map((ticket) => ticket.id),
      currentTicketId: targetAgent.currentTicketId ?? null,
    });
  }

  const terminalTarget = await resolveAgentTerminalTarget(targetAgent);
  let captureText = "";
  try {
    captureText = await captureTerminalTarget(terminalTarget);
  } catch {
    captureText = "";
  }

  if (captureText && isTerminalCaptureBusy(captureText)) {
    throw new CLIError("TRANSFER_TARGET_TERMINAL_BUSY", `Agent ${targetAgent.displayName} 当前终端会话忙碌。`, {
      agentId: targetAgent.id,
      agentName: targetAgent.displayName,
    });
  }

  return terminalTarget;
}

export async function transferTicket({
  ticketId,
  targetNames,
  terminalTarget,
  textOverride = null,
  cliPath,
  nodePath,
  abortSignal = null,
}) {
  const parentTicket = loadTicket(ticketId);
  if (!parentTicket) {
    throw new CLIError("TICKET_NOT_FOUND", `Ticket ${ticketId} was not found.`, {
      ticketId,
    });
  }

  if (parentTicket.status !== "pending") {
    throw new CLIError("TICKET_NOT_PENDING", `Ticket ${ticketId} is already ${parentTicket.status}.`, {
      ticketId,
      status: parentTicket.status,
    });
  }

  const currentAgent = findAgentBySessionHandle(terminalTarget?.handle, { onlyLive: true });
  if (!currentAgent) {
    throw new CLIError("TRANSFER_SOURCE_AGENT_REQUIRED", "transfer must be called from a connected agent terminal session.");
  }

  if (currentAgent.id !== parentTicket.agentId) {
    throw new CLIError("TRANSFER_SOURCE_MISMATCH", `Ticket ${ticketId} currently belongs to ${parentTicket.agentName}.`, {
      ticketId,
      ticketAgentId: parentTicket.agentId,
      ticketAgentName: parentTicket.agentName,
      currentAgentId: currentAgent.id,
      currentAgentName: currentAgent.displayName,
    });
  }

  const normalizedTargetNames = normalizeTransferTargets(targetNames);
  if (normalizedTargetNames.length === 0) {
    throw new CLIError("TRANSFER_TARGET_REQUIRED", "transfer requires at least one target agent name via --to.");
  }

  const targets = normalizedTargetNames.map((name) => {
    const agent = findAgentByDisplayName(name, { onlyLive: true });
    if (!agent) {
      throw new CLIError("TRANSFER_TARGET_NOT_FOUND", `No live agent named ${name} was found.`, {
        targetName: name,
      });
    }
    if (agent.id === currentAgent.id) {
      throw new CLIError("TRANSFER_TARGET_SAME_AS_SOURCE", `Transfer target ${name} is the current agent itself.`, {
        targetName: name,
      });
    }
    return agent;
  });

  const routedText = typeof textOverride === "string" && textOverride.trim()
    ? textOverride.trim()
    : parentTicket.inboundText;

  const validatedTargets = [];
  for (const agent of targets) {
    validatedTargets.push({
      agent,
      terminalTarget: await ensureTransferTargetReady(agent, parentTicket.id),
    });
  }

  const childTickets = validatedTargets.map(({ agent, terminalTarget }) => ({
    agent,
    terminalTarget,
    ticket: createTicket({
      accountId: parentTicket.accountId,
      agentId: agent.id,
      agentName: agent.displayName,
      sessionHandle: terminalTarget.handle,
      sessionApp: terminalTarget.app,
      toUserId: parentTicket.toUserId,
      contextToken: parentTicket.contextToken,
      inboundText: routedText,
      inboundItems: Array.isArray(parentTicket.inboundItems) ? parentTicket.inboundItems : [],
      messageId: parentTicket.messageId ?? null,
      conversationId: parentTicket.conversationId ?? parentTicket.toUserId ?? null,
      chatType: parentTicket.chatType ?? "direct",
      senderUserId: parentTicket.senderUserId ?? parentTicket.toUserId ?? null,
      groupId: parentTicket.groupId ?? null,
      sessionId: parentTicket.sessionId ?? null,
      parentTicketId: parentTicket.id,
      transferSourceAgentId: currentAgent.id,
      transferSourceAgentName: currentAgent.displayName,
      transferDepth: Number(parentTicket.transferDepth ?? 0) + 1,
      routeSource: "agent-transfer",
    }),
  }));

  const succeeded = [];
  const failed = [];

  for (const child of childTickets) {
    const promptText = buildInjectedPrompt({
      ticket: child.ticket,
      cliPath,
      nodePath,
    });

    setAgentTicket(child.agent.id, child.ticket.id);

    try {
      const injection = await injectPromptIntoSession({
        terminalTarget: child.terminalTarget,
        promptText,
        abortSignal,
      });

      const nextTicket = updateTicket(child.ticket.id, {
        injectedAt: new Date().toISOString(),
        injection,
        promptText,
      });

      updateAgent(child.agent.id, {
        target: child.terminalTarget,
      });

      succeeded.push({
        agent: child.agent,
        ticket: nextTicket ?? child.ticket,
        terminalTarget: child.terminalTarget,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      updateTicket(child.ticket.id, {
        status: "failed",
        failedAt: new Date().toISOString(),
        errorMessage,
        promptText,
      });
      setAgentTicket(child.agent.id, null);
      failed.push({
        agentId: child.agent.id,
        agentName: child.agent.displayName,
        ticketId: child.ticket.id,
        error: errorMessage,
      });
    }
  }

  if (succeeded.length === 0) {
    throw new CLIError("TRANSFER_FAILED", `Failed to transfer ticket ${ticketId} to the requested target agent(s).`, {
      ticketId,
      failed,
    });
  }

  setAgentTicket(currentAgent.id, null);

  const nextParentTicket = updateTicket(parentTicket.id, {
    status: succeeded.length > 1 ? "delegated" : "transferred",
    delegatedAt: new Date().toISOString(),
    delegatedByAgentId: currentAgent.id,
    delegatedByAgentName: currentAgent.displayName,
    delegatedChildTicketIds: succeeded.map((item) => item.ticket.id),
    delegatedChildAgentIds: succeeded.map((item) => item.agent.id),
    delegatedChildAgentNames: succeeded.map((item) => item.agent.displayName),
    delegatedFailures: failed,
  });

  appendEvent({
    type: "wechat.ticket.transferred",
    accountId: parentTicket.accountId,
    conversationId: parentTicket.conversationId ?? parentTicket.toUserId,
    payload: {
      parentTicketId: parentTicket.id,
      delegatedByAgentId: currentAgent.id,
      delegatedByAgentName: currentAgent.displayName,
      childTicketIds: succeeded.map((item) => item.ticket.id),
      childAgentIds: succeeded.map((item) => item.agent.id),
      childAgentNames: succeeded.map((item) => item.agent.displayName),
      failed,
    },
  });

  return {
    ok: true,
    action: "transfer",
    parentTicket: nextParentTicket ?? parentTicket,
    delegatedByAgent: currentAgent,
    targets: succeeded.map((item) => item.agent),
    tickets: succeeded.map((item) => item.ticket),
    failed,
  };
}
