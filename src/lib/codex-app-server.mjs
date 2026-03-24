import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

function makeRequestError(method, error) {
  const message =
    typeof error?.message === "string"
      ? error.message
      : `App-server request failed: ${method}`;
  const next = new Error(message);
  next.code = error?.code ?? "APP_SERVER_REQUEST_FAILED";
  next.details = error?.data ?? null;
  return next;
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    codexBin = "codex",
    cwd = process.cwd(),
    sessionSource = "appServer",
    clientName = "weixin-agent",
    clientVersion = "0.1.0",
  } = {}) {
    super();
    this.codexBin = codexBin;
    this.cwd = cwd;
    this.sessionSource = sessionSource;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.proc = null;
    this.buffer = "";
    this.nextRequestId = 1;
    this.pending = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) {
      return;
    }

    this.proc = spawn(
      this.codexBin,
      ["app-server", "--listen", "stdio://", "--session-source", this.sessionSource],
      {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      this.flushBuffer();
    });

    this.proc.stderr.on("data", (chunk) => {
      this.emit("stderr", String(chunk));
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.started = false;
      this.emit("exit", { code, signal });
    });

    this.started = true;
    await this.request("initialize", {
      clientInfo: {
        name: this.clientName,
        version: this.clientVersion,
      },
    });
  }

  flushBuffer() {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (rawLine !== "") {
        this.handleMessage(rawLine);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  handleMessage(rawLine) {
    let payload;
    try {
      payload = JSON.parse(rawLine);
    } catch {
      this.emit("raw", rawLine);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "id") && (payload.result !== undefined || payload.error !== undefined)) {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(makeRequestError(pending.method, payload.error));
        return;
      }
      pending.resolve(payload.result);
      return;
    }

    if (payload.method) {
      this.emit("notification", payload);
      this.emit(payload.method, payload.params ?? {});
      return;
    }

    this.emit("raw", payload);
  }

  request(method, params = {}, timeoutMs = 300_000) {
    if (!this.proc || !this.started) {
      return Promise.reject(new Error("Codex app-server is not started."));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      });

      const message = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async close() {
    if (!this.proc) {
      return;
    }
    if (!this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this.started = false;
  }
}
