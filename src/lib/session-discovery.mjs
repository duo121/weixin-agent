export function resolveCurrentCodexThreadTarget({ threadId = null, env = process.env } = {}) {
  if (typeof threadId === "string" && threadId.trim() !== "") {
    return {
      threadId: threadId.trim(),
      source: "flag",
    };
  }

  if (typeof env.CODEX_THREAD_ID === "string" && env.CODEX_THREAD_ID.trim() !== "") {
    return {
      threadId: env.CODEX_THREAD_ID.trim(),
      source: "env.CODEX_THREAD_ID",
    };
  }

  return null;
}
