import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { loadConfigRouteTag, normalizeAccountId, saveAccount } from "./accounts.mjs";
import { appendEvent } from "./events.mjs";
import { renderQR } from "./qr.mjs";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;

const activeLogins = new Map();

function logProgress(message) {
  process.stderr.write(`${message}\n`);
}

function displayQR(url) {
  if (!url) {
    logProgress("未收到二维码链接。");
    return;
  }

  logProgress("请使用微信扫码：");
  logProgress("");

  const qrArt = renderQR(url);
  if (qrArt) {
    for (const line of qrArt.split("\n")) {
      logProgress(line);
    }
    logProgress("");
  }

  logProgress(`二维码链接: ${url}`);
}

function isLoginFresh(login) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins() {
  for (const [key, value] of activeLogins.entries()) {
    if (!isLoginFresh(value)) {
      activeLogins.delete(key);
    }
  }
}

function buildHeaders(extra = {}) {
  const headers = { ...extra };
  const routeTag = loadConfigRouteTag();
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }
  return headers;
}

async function fetchQRCode(apiBaseUrl, botType) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const response = await fetch(url, {
    headers: buildHeaders(),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} ${body}`);
  }
  return response.json();
}

async function pollQRStatus(apiBaseUrl, qrcode) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: buildHeaders({
        "iLink-App-ClientVersion": "1",
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText} ${raw}`);
    }
    return JSON.parse(raw);
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
}

function openQrInBrowser(url) {
  if (!url) {
    return false;
  }

  const platform = process.platform;
  const command =
    platform === "darwin" ? "open"
      : platform === "win32" ? "cmd"
      : "xdg-open";
  const args =
    platform === "win32" ? ["/c", "start", "", url]
      : [url];

  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function startQrLogin({
  baseUrl = DEFAULT_BASE_URL,
  botType = DEFAULT_BOT_TYPE,
  openBrowser = false,
  printOnly = false,
}) {
  purgeExpiredLogins();

  const sessionKey = randomUUID();
  const qr = await fetchQRCode(baseUrl, botType);
  const login = {
    sessionKey,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: Date.now(),
  };
  activeLogins.set(sessionKey, login);

  displayQR(qr.qrcode_img_content);

  if (openBrowser) {
    const opened = openQrInBrowser(qr.qrcode_img_content);
    if (opened) {
      logProgress("二维码已尝试在浏览器中打开。");
    }
  }

  if (printOnly) {
    appendEvent({
      type: "account.login.qr_ready",
      payload: {
        sessionKey,
        baseUrl,
        qrcodeUrl: qr.qrcode_img_content,
        printOnly: true,
      },
    });
    return {
      ok: true,
      action: "account.login",
      status: "qr_ready",
      sessionKey,
      baseUrl,
      qrcodeUrl: qr.qrcode_img_content,
      saved: false,
    };
  }

  appendEvent({
    type: "account.login.qr_ready",
    payload: {
      sessionKey,
      baseUrl,
      qrcodeUrl: qr.qrcode_img_content,
      printOnly: false,
    },
  });

  return {
    ok: true,
    action: "account.login",
    status: "waiting_for_scan",
    sessionKey,
    baseUrl,
    qrcodeUrl: qr.qrcode_img_content,
    saved: false,
  };
}

export async function waitForQrLogin({
  sessionKey,
  baseUrl = DEFAULT_BASE_URL,
  botType = DEFAULT_BOT_TYPE,
  timeoutMs = 480_000,
}) {
  let login = activeLogins.get(sessionKey);
  if (!login) {
    throw new Error("No active QR login session was found.");
  }

  const deadline = Date.now() + Math.max(timeoutMs, 1_000);
  let refreshCount = 1;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, login.qrcode);

    switch (status.status) {
      case "wait":
        break;

      case "scaned":
        if (!scannedPrinted) {
          logProgress("已扫码，请在微信中确认。");
          scannedPrinted = true;
        }
        break;

      case "expired": {
        refreshCount += 1;
        if (refreshCount > MAX_QR_REFRESH_COUNT) {
          activeLogins.delete(sessionKey);
          throw new Error("QR code expired too many times.");
        }

        logProgress(`二维码已过期，正在刷新...(${refreshCount}/${MAX_QR_REFRESH_COUNT})`);
        const qr = await fetchQRCode(baseUrl, botType);
        login = {
          ...login,
          qrcode: qr.qrcode,
          qrcodeUrl: qr.qrcode_img_content,
          startedAt: Date.now(),
        };
        activeLogins.set(sessionKey, login);
        scannedPrinted = false;
        displayQR(qr.qrcode_img_content);
        if (openBrowser) {
          openQrInBrowser(qr.qrcode_img_content);
        }
        break;
      }

      case "confirmed": {
        activeLogins.delete(sessionKey);

        if (!status.ilink_bot_id || !status.bot_token) {
          throw new Error("Login confirmed but bot id or token is missing.");
        }

        const normalizedAccountId = normalizeAccountId(status.ilink_bot_id);
        const account = saveAccount(normalizedAccountId, {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          userId: status.ilink_user_id,
        });

        appendEvent({
          type: "account.login.connected",
          accountId: normalizedAccountId,
          payload: {
            baseUrl: status.baseurl || baseUrl,
            userId: status.ilink_user_id ?? null,
          },
        });

        return {
          ok: true,
          action: "account.login",
          status: "connected",
          saved: true,
          account,
          accountId: normalizedAccountId,
          baseUrl: status.baseurl || baseUrl,
          userId: status.ilink_user_id ?? null,
        };
      }

      default:
        break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  activeLogins.delete(sessionKey);
  throw new Error("Login timed out.");
}

export async function loginAccount(options = {}) {
  const started = await startQrLogin(options);
  if (options.printOnly) {
    return started;
  }
  return waitForQrLogin({
    sessionKey: started.sessionKey,
    baseUrl: options.baseUrl,
    botType: options.botType,
    timeoutMs: options.timeoutMs,
  });
}
