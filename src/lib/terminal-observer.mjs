import { captureTerminalTarget } from "./terminal-control.mjs";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 800;
const DEFAULT_STABLE_POLLS = 2;

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

export function normalizeTerminalCaptureText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function toLines(text) {
  const normalized = normalizeTerminalCaptureText(text);
  return normalized === "" ? [] : normalized.split("\n");
}

function isPromptLine(line) {
  return /^\s*›(?:\s|$)/.test(line);
}

function isStatusLine(line) {
  return /^\s*gpt-[\w.-]+(?:\s+\w+)?\s+·/.test(line.trim());
}

function isBusyLine(line) {
  return /esc to interrupt/i.test(line) || /^\s*[•◦]?\s*Working\b/i.test(line);
}

export function isTerminalCaptureBusy(text) {
  return toLines(text).some(isBusyLine);
}

function computeInsertedLines(beforeText, afterText) {
  const beforeLines = toLines(beforeText);
  const afterLines = toLines(afterText);

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return afterLines.slice(prefix, afterLines.length - suffix);
}

function trimEmptyEdges(lines) {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }

  return lines.slice(start, end);
}

function dropUserBlock(lines) {
  const trimmed = trimEmptyEdges(lines);
  if (trimmed.length === 0) {
    return [];
  }

  let index = 1;
  while (index < trimmed.length && trimmed[index].trim() !== "") {
    index += 1;
  }
  while (index < trimmed.length && trimmed[index].trim() === "") {
    index += 1;
  }

  return trimmed.slice(index);
}

export function extractReplyTextFromTerminalDiff({
  beforeText,
  afterText,
}) {
  const insertedLines = computeInsertedLines(beforeText, afterText);
  const candidateLines = [];

  for (const line of dropUserBlock(insertedLines)) {
    if (isBusyLine(line)) {
      continue;
    }
    if (isPromptLine(line) || isStatusLine(line)) {
      break;
    }
    candidateLines.push(line);
  }

  const trimmed = trimEmptyEdges(candidateLines);
  if (trimmed.length === 0) {
    return "";
  }

  const normalized = [...trimmed];
  normalized[0] = normalized[0].replace(/^\s*[•◦]\s+/, "");
  return normalized.join("\n").trim();
}

export async function waitForTerminalTurnCompletion({
  terminalTarget,
  beforeText,
  abortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  stablePolls = DEFAULT_STABLE_POLLS,
}) {
  const baselineText = normalizeTerminalCaptureText(
    beforeText ?? await captureTerminalTarget(terminalTarget),
  );
  const startedAt = Date.now();
  let lastCapture = null;
  let stableCount = 0;
  let busySeen = isTerminalCaptureBusy(baselineText);
  let bestReplyText = "";
  let bestCapture = baselineText;

  while (Date.now() - startedAt < timeoutMs) {
    if (abortSignal?.aborted) {
      throw new Error("aborted");
    }

    const captureText = normalizeTerminalCaptureText(
      await captureTerminalTarget(terminalTarget),
    );

    if (captureText === lastCapture) {
      stableCount += 1;
    } else {
      lastCapture = captureText;
      stableCount = 0;
    }

    const busy = isTerminalCaptureBusy(captureText);
    if (busy) {
      busySeen = true;
    }

    if (captureText !== baselineText) {
      bestCapture = captureText;
      const replyText = extractReplyTextFromTerminalDiff({
        beforeText: baselineText,
        afterText: captureText,
      });
      if (replyText) {
        bestReplyText = replyText;
      }

      const settled =
        !busy &&
        (
          (busySeen && stableCount >= stablePolls) ||
          (!busySeen && bestReplyText !== "" && stableCount >= stablePolls)
        );

      if (settled) {
        return {
          text: bestReplyText,
          source: "terminal-capture",
          busySeen,
          captureText,
        };
      }
    }

    await sleep(pollIntervalMs, abortSignal);
  }

  throw new Error(
    `Timed out waiting for terminal completion: ${terminalTarget.handle ?? terminalTarget.sessionId ?? "unknown-target"}`,
  );
}
