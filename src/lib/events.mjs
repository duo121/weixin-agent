import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { lastLines } from "./io.mjs";
import { resolveAgentEventsPath, resolveAgentStateDir } from "./paths.mjs";

export function appendEvent({
  type,
  accountId = null,
  conversationId = null,
  payload = {},
}) {
  fs.mkdirSync(resolveAgentStateDir(), { recursive: true });
  const entry = {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    accountId,
    conversationId,
    payload,
  };
  fs.appendFileSync(resolveAgentEventsPath(), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function readEventLines(lineCount = 50) {
  const filePath = resolveAgentEventsPath();
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      lines: [],
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const text = lastLines(raw.trimEnd(), lineCount);
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {
          malformed: true,
          raw: line,
        };
      }
    });

  return {
    filePath,
    lines,
  };
}
