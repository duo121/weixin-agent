import fs from "node:fs";
import path from "node:path";

import {
  resolveAgentConfigPath,
  resolveAgentStateDir,
} from "./paths.mjs";

const DEFAULT_CONFIG = {
  currentAccount: null,
  defaultAttach: "current-codex",
  defaultBridgeMode: "terminal-inject",
  agentNameTemplate: "元宝{n}号",
  autoSpawnOnNoAgents: true,
  autoSpawnKind: "codex",
  autoSpawnApp: "iterm2",
  autoSpawnCommand: "codex",
  autoSpawnWarmupMs: 2500,
  autoSpawnWaitForAgentMs: 8000,
  autoSpawnNameTemplate: null,
  autoSpawnCwd: null,
  routeTag: null,
  cdnBaseUrl: null,
  updatedAt: null,
};

export function ensureAgentStateDir() {
  fs.mkdirSync(resolveAgentStateDir(), { recursive: true });
}

export function loadConfig() {
  const filePath = resolveAgentConfigPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(nextConfig) {
  ensureAgentStateDir();
  const filePath = resolveAgentConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    ...DEFAULT_CONFIG,
    ...nextConfig,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export function setConfigValue(key, value) {
  const config = loadConfig();
  config[key] = value;
  return saveConfig(config);
}
