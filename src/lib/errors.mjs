export class CLIError extends Error {
  constructor(code, message, details = null, exitCode = 1) {
    super(message);
    this.name = "CLIError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function toErrorPayload(error) {
  if (error instanceof CLIError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? undefined,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
