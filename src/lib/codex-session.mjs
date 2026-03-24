import { CodexAppServerClient } from "./codex-app-server.mjs";

function isAgentMessageItem(item) {
  return item && item.type === "agentMessage" && typeof item.text === "string";
}

function isUserMessageItem(item) {
  return item && item.type === "userMessage" && Array.isArray(item.content);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isTerminalTurnStatus(status) {
  return status === "completed" || status === "error" || status === "failed";
}

export function extractReplyTextFromItems(items) {
  const finalAnswerItems = items.filter((item) => isAgentMessageItem(item) && item.phase === "final_answer");
  if (finalAnswerItems.length > 0) {
    return finalAnswerItems.map((item) => item.text).join("\n").trim();
  }

  const plainAgentItems = items.filter(isAgentMessageItem);
  if (plainAgentItems.length > 0) {
    return plainAgentItems.map((item) => item.text).join("\n").trim();
  }

  return "";
}

export function extractReplyTextFromTurn(turn) {
  return extractReplyTextFromItems(turn?.items ?? []);
}

export function extractUserTextFromTurn(turn) {
  const userItems = (turn?.items ?? []).filter(isUserMessageItem);
  if (userItems.length === 0) {
    return "";
  }

  return userItems
    .flatMap((item) => item.content ?? [])
    .filter((content) => content?.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class CodexSessionController {
  constructor({
    threadId,
    cwd = process.cwd(),
    codexBin = "codex",
  }) {
    this.threadId = threadId;
    this.cwd = cwd;
    this.client = new CodexAppServerClient({
      codexBin,
      cwd,
    });
    this.serial = Promise.resolve();
  }

  async start() {
    await this.client.start();
    let resumed;
    try {
      resumed = await this.client.request("thread/resume", {
        threadId: this.threadId,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("no rollout found")) {
        throw new Error(
          `Codex thread ${this.threadId} is not materialized on disk yet. Send one local message in that TUI session first, then start or retry the bridge.`,
        );
      }
      throw error;
    }
    this.thread = resumed.thread;
    return resumed;
  }

  async close() {
    await this.client.close();
  }

  async readThread({ includeTurns = true } = {}) {
    return this.client.request("thread/read", {
      threadId: this.threadId,
      includeTurns,
    });
  }

  async readTurn(turnId) {
    const result = await this.readThread({
      includeTurns: true,
    });
    return result.thread?.turns?.find((turn) => turn.id === turnId) ?? null;
  }

  async getThreadSnapshot() {
    const result = await this.readThread({
      includeTurns: true,
    });
    const turns = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
    const lastTurn = turns.at(-1) ?? null;
    const lastTurnStatus = typeof lastTurn?.status === "string" ? lastTurn.status : null;
    return {
      threadId: this.threadId,
      turns,
      turnCount: turns.length,
      lastTurnId: lastTurn?.id ?? null,
      lastTurnStatus,
      idle: !lastTurn || isTerminalTurnStatus(lastTurnStatus),
    };
  }

  async waitForNextCompletedTurn({
    afterTurnCount = 0,
    expectedUserText = null,
    timeoutMs = 300_000,
    pollIntervalMs = 1_000,
  } = {}) {
    const startedAt = Date.now();
    const expected = normalizeText(expectedUserText);

    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = await this.getThreadSnapshot();
      const candidateTurns = snapshot.turns.slice(Math.max(0, afterTurnCount));

      for (const turn of candidateTurns) {
        if (expected && normalizeText(extractUserTextFromTurn(turn)) !== expected) {
          continue;
        }

        if (turn.status === "completed") {
          return {
            threadId: this.threadId,
            turnId: turn.id,
            text: extractReplyTextFromTurn(turn),
            turn,
          };
        }

        if (turn.status === "error" || turn.status === "failed") {
          throw new Error(`Codex turn failed: ${turn.error ?? turn.id}`);
        }
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(`Timed out waiting for the next Codex turn in thread ${this.threadId}`);
  }

  async sendTextTurn(text, options = {}) {
    const run = this.serial
      .catch(() => {})
      .then(() => this.#sendTextTurn(text, options));
    this.serial = run.catch(() => {});
    return run;
  }

  async #sendTextTurn(text, options = {}) {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const collectedAgentItems = [];
    const deltaByItemId = new Map();
    const preTurnEvents = [];
    let turnId = null;
    let cleanup = () => {};

    const onAgentDelta = (params) => {
      if (params.threadId !== this.threadId) {
        return;
      }
      if (!turnId) {
        preTurnEvents.push({ type: "delta", params });
        return;
      }
      if (params.turnId !== turnId) {
        return;
      }
      const next = `${deltaByItemId.get(params.itemId) ?? ""}${params.delta ?? ""}`;
      deltaByItemId.set(params.itemId, next);
    };

    const onItemCompleted = (params) => {
      if (params.threadId !== this.threadId) {
        return;
      }
      if (!turnId) {
        preTurnEvents.push({ type: "completed", params });
        return;
      }
      if (params.turnId !== turnId) {
        return;
      }
      if (isAgentMessageItem(params.item)) {
        collectedAgentItems.push(params.item);
      }
    };

    const completionPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Codex turn completion: ${this.threadId}`));
      }, timeoutMs);

      const onTurnCompleted = (params) => {
        if (params.threadId !== this.threadId) {
          return;
        }
        if (!turnId || params.turn.id !== turnId) {
          return;
        }
        clearTimeout(timer);
        cleanup();
        resolve(params.turn);
      };

      cleanup = () => {
        this.client.off("item/agentMessage/delta", onAgentDelta);
        this.client.off("item/completed", onItemCompleted);
        this.client.off("turn/completed", onTurnCompleted);
      };

      this.client.on("item/agentMessage/delta", onAgentDelta);
      this.client.on("item/completed", onItemCompleted);
      this.client.on("turn/completed", onTurnCompleted);
    });

    let started;
    try {
      started = await this.client.request("turn/start", {
        threadId: this.threadId,
        input: [
          {
            type: "text",
            text,
          },
        ],
      }, timeoutMs);
    } catch (error) {
      cleanup();
      throw error;
    }

    turnId = started.turn.id;

    for (const event of preTurnEvents) {
      if (event.params.turnId !== turnId) {
        continue;
      }
      if (event.type === "delta") {
        const next = `${deltaByItemId.get(event.params.itemId) ?? ""}${event.params.delta ?? ""}`;
        deltaByItemId.set(event.params.itemId, next);
        continue;
      }
      if (event.type === "completed" && isAgentMessageItem(event.params.item)) {
        collectedAgentItems.push(event.params.item);
      }
    }

    await completionPromise;

    let replyText = extractReplyTextFromItems(collectedAgentItems);
    if (!replyText && deltaByItemId.size > 0) {
      replyText = Array.from(deltaByItemId.values()).join("").trim();
    }

    let storedTurn = null;
    if (!replyText) {
      storedTurn = await this.readTurn(turnId);
      replyText = extractReplyTextFromItems(storedTurn?.items ?? []);
    }

    return {
      threadId: this.threadId,
      turnId,
      text: replyText,
      turn: storedTurn,
      items: collectedAgentItems,
    };
  }
}
