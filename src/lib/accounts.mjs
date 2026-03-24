import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import {
  resolveLegacyOpenClawStateDir,
  resolveLegacyWeixinAccountsDir,
  resolveLegacyWeixinAccountsIndexPath,
  resolveWeixinAccountsDir,
  resolveWeixinAccountsIndexPath,
} from "./paths.mjs";

export function normalizeAccountId(raw) {
  return raw.trim().toLowerCase().replace(/[@.]/g, "-");
}

export function listAccountIds() {
  for (const filePath of [resolveWeixinAccountsIndexPath(), resolveLegacyWeixinAccountsIndexPath()]) {
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        continue;
      }
      return parsed.filter((value) => typeof value === "string" && value.trim() !== "");
    } catch {
      // try next path
    }
  }
  return [];
}

export function resolveAccountPath(accountId, {
  legacy = false,
} = {}) {
  const dir = legacy ? resolveLegacyWeixinAccountsDir() : resolveWeixinAccountsDir();
  return path.join(dir, `${normalizeAccountId(accountId)}.json`);
}

function persistPrimaryAccountSnapshot(accountId, parsed) {
  const normalized = normalizeAccountId(accountId);
  const filePath = resolveAccountPath(normalized);
  const payload = {
    ...(typeof parsed?.token === "string" && parsed.token.trim() ? { token: parsed.token.trim() } : {}),
    baseUrl: typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim()
      ? parsed.baseUrl.trim()
      : "https://ilinkai.weixin.qq.com",
    savedAt: typeof parsed?.savedAt === "string" && parsed.savedAt.trim()
      ? parsed.savedAt
      : new Date().toISOString(),
    ...(typeof parsed?.userId === "string" && parsed.userId.trim() ? { userId: parsed.userId.trim() } : {}),
    ...(typeof parsed?.routeTag === "string" && parsed.routeTag.trim() ? { routeTag: parsed.routeTag.trim() } : {}),
    ...(typeof parsed?.cdnBaseUrl === "string" && parsed.cdnBaseUrl.trim() ? { cdnBaseUrl: parsed.cdnBaseUrl.trim() } : {}),
  };

  fs.mkdirSync(resolveWeixinAccountsDir(), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
  registerAccountId(normalized);
  return filePath;
}

export function loadAccount(accountId) {
  for (const legacy of [false, true]) {
    const filePath = resolveAccountPath(accountId, { legacy });
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const primaryFilePath = legacy ? persistPrimaryAccountSnapshot(accountId, parsed) : filePath;
      return {
        id: normalizeAccountId(accountId),
        configured: Boolean(parsed?.token),
        baseUrl: parsed?.baseUrl ?? "https://ilinkai.weixin.qq.com",
        savedAt: parsed?.savedAt ?? null,
        userId: parsed?.userId ?? null,
        routeTag: typeof parsed?.routeTag === "string" && parsed.routeTag.trim() ? parsed.routeTag.trim() : null,
        cdnBaseUrl: typeof parsed?.cdnBaseUrl === "string" && parsed.cdnBaseUrl.trim() ? parsed.cdnBaseUrl.trim() : null,
        filePath: primaryFilePath,
        legacy: false,
      };
    } catch {
      // try next path
    }
  }
  return null;
}

export function loadAccountCredentials(accountId) {
  for (const legacy of [false, true]) {
    const filePath = resolveAccountPath(accountId, { legacy });
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const primaryFilePath = legacy ? persistPrimaryAccountSnapshot(accountId, parsed) : filePath;
      return {
        id: normalizeAccountId(accountId),
        configured: Boolean(parsed?.token),
        token: typeof parsed?.token === "string" && parsed.token.trim() !== "" ? parsed.token.trim() : null,
        baseUrl: parsed?.baseUrl ?? "https://ilinkai.weixin.qq.com",
        savedAt: parsed?.savedAt ?? null,
        userId: parsed?.userId ?? null,
        routeTag: typeof parsed?.routeTag === "string" && parsed.routeTag.trim() ? parsed.routeTag.trim() : null,
        cdnBaseUrl: typeof parsed?.cdnBaseUrl === "string" && parsed.cdnBaseUrl.trim() ? parsed.cdnBaseUrl.trim() : null,
        filePath: primaryFilePath,
        legacy: false,
      };
    } catch {
      // try next path
    }
  }
  return null;
}

export function listAccounts() {
  return listAccountIds().map((id) => loadAccount(id) ?? {
    id,
    configured: false,
    baseUrl: "https://ilinkai.weixin.qq.com",
    savedAt: null,
    userId: null,
    filePath: resolveAccountPath(id),
  });
}

export function registerAccountId(accountId) {
  const normalized = normalizeAccountId(accountId);
  const existing = listAccountIds().map((id) => normalizeAccountId(id));
  const next = [...new Set([...existing, normalized])];
  fs.mkdirSync(resolveWeixinAccountsDir(), { recursive: true });
  fs.writeFileSync(resolveWeixinAccountsIndexPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function saveAccount(accountId, update) {
  const normalized = normalizeAccountId(accountId);
  const filePath = resolveAccountPath(normalized);
  const existing = loadAccount(normalized);
  const data = {
    ...(update.token ? { token: String(update.token).trim() } : existing?.configured ? { token: "__present__" } : {}),
    baseUrl: String(update.baseUrl ?? existing?.baseUrl ?? "https://ilinkai.weixin.qq.com").trim(),
    savedAt: new Date().toISOString(),
    ...(update.userId ? { userId: String(update.userId).trim() } : existing?.userId ? { userId: existing.userId } : {}),
    ...(typeof update.routeTag === "string" && update.routeTag.trim()
      ? { routeTag: update.routeTag.trim() }
      : existing?.routeTag ? { routeTag: existing.routeTag } : {}),
    ...(typeof update.cdnBaseUrl === "string" && update.cdnBaseUrl.trim()
      ? { cdnBaseUrl: update.cdnBaseUrl.trim() }
      : existing?.cdnBaseUrl ? { cdnBaseUrl: existing.cdnBaseUrl } : {}),
  };

  fs.mkdirSync(resolveWeixinAccountsDir(), { recursive: true });

  const persisted = {
    ...(update.token ? { token: String(update.token).trim() } : {}),
    baseUrl: data.baseUrl,
    savedAt: data.savedAt,
    ...(data.userId ? { userId: data.userId } : {}),
    ...(data.routeTag ? { routeTag: data.routeTag } : {}),
    ...(data.cdnBaseUrl ? { cdnBaseUrl: data.cdnBaseUrl } : {}),
  };
  fs.writeFileSync(filePath, JSON.stringify(persisted, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }

  registerAccountId(normalized);
  return loadAccount(normalized);
}

function loadLegacyOpenClawChannelConfig() {
  const envPath = process.env.OPENCLAW_CONFIG?.trim();
  const configPath = envPath || path.join(resolveLegacyOpenClawStateDir(), "openclaw.json");
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const section = parsed?.channels?.["openclaw-weixin"];
    return section && typeof section === "object" ? section : null;
  } catch {
    return null;
  }
}

export function loadConfigRouteTag(accountId = null) {
  const envValue = process.env.WEIXIN_AGENT_ROUTE_TAG?.trim();
  if (envValue) {
    return envValue;
  }

  if (accountId) {
    const account = loadAccountCredentials(accountId);
    if (typeof account?.routeTag === "string" && account.routeTag.trim()) {
      return account.routeTag.trim();
    }
  }

  const config = loadConfig();
  if (typeof config.routeTag === "string" && config.routeTag.trim()) {
    return config.routeTag.trim();
  }

  const legacySection = loadLegacyOpenClawChannelConfig();
  if (legacySection) {
    if (accountId) {
      const value = legacySection.accounts?.[accountId]?.routeTag;
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (typeof value === "number") {
        return String(value);
      }
    }
    if (typeof legacySection.routeTag === "string" && legacySection.routeTag.trim()) {
      return legacySection.routeTag.trim();
    }
    if (typeof legacySection.routeTag === "number") {
      return String(legacySection.routeTag);
    }
  }

  return undefined;
}

export function loadConfigCdnBaseUrl(accountId = null) {
  const envValue = process.env.WEIXIN_AGENT_CDN_BASE_URL?.trim();
  if (envValue) {
    return envValue;
  }

  if (accountId) {
    const account = loadAccountCredentials(accountId);
    if (typeof account?.cdnBaseUrl === "string" && account.cdnBaseUrl.trim()) {
      return account.cdnBaseUrl.trim();
    }
  }

  const config = loadConfig();
  if (typeof config.cdnBaseUrl === "string" && config.cdnBaseUrl.trim()) {
    return config.cdnBaseUrl.trim();
  }

  const legacySection = loadLegacyOpenClawChannelConfig();
  if (legacySection) {
    if (accountId) {
      const value = legacySection.accounts?.[accountId]?.cdnBaseUrl;
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    if (typeof legacySection.cdnBaseUrl === "string" && legacySection.cdnBaseUrl.trim()) {
      return legacySection.cdnBaseUrl.trim();
    }
  }

  return undefined;
}

export function removeAccount(accountId) {
  const normalized = normalizeAccountId(accountId);
  const filePath = resolveAccountPath(normalized);
  let removed = false;

  try {
    fs.unlinkSync(filePath);
    removed = true;
  } catch {
    removed = false;
  }

  const ids = listAccountIds().filter((id) => normalizeAccountId(id) !== normalized);
  try {
    fs.mkdirSync(resolveWeixinAccountsDir(), { recursive: true });
    fs.writeFileSync(resolveWeixinAccountsIndexPath(), JSON.stringify(ids, null, 2), "utf8");
  } catch {
    // best effort
  }

  return { removed, accountId: normalized, filePath };
}
