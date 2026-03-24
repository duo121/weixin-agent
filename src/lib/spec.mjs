import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveAgentAccountHistoryPath,
  resolveAgentAgentsDir,
  resolveAgentConnectionLogPath,
  resolveAgentBridgeLogPath,
  resolveAgentConfigPath,
  resolveAgentConversationHistoryDir,
  resolveAgentConversationRoutesDir,
  resolveAgentEventsPath,
  resolveAgentRouterLogPath,
  resolveAgentRuntimePath,
  resolveAgentStateDir,
  resolveAgentTicketsDir,
  resolveCodexSessionIndexPath,
  resolveCodexStateDir,
  resolveLegacyAgentRuntimePath,
  resolveLegacyAgentStateDir,
  resolveStateDir,
  resolveWeixinAccountsDir,
  resolveWeixinAccountsIndexPath,
} from "./paths.mjs";

function readVersion() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildSpec() {
  return {
    ok: true,
    source: "weixin-agent",
    specVersion: 1,
    cli: {
      name: "weixin-agent",
      aliases: ["wxagent"],
      version: readVersion(),
    },
    purpose: "AI-native router CLI for bridging one WeChat account to zero or more local AI terminal sessions, with strict @ routing, 0-agent auto-spawn fallback, recent-agent fallback, explicit ticket transfer, and ticket reply as the primary control flow.",
    recommendedWorkflow: [
      "Use spec to read the machine contract.",
      "Use doctor to inspect state paths, accounts, and local Codex prerequisites.",
      "Use account login or account use to resolve local WeChat credential state.",
      "Use start --dry-run to preview the global router startup plan.",
      "Use start to launch the background WeChat router daemon.",
      "If zero live agents are online when a WeChat message arrives, the router can auto-spawn one default agent terminal and then continue routing that message. Without an explicit @name, that first agent defaults to 元宝一号.",
      "Use spawn --name <displayName> when one existing agent should proactively create another named Codex / Claude terminal and connect it into the router. Later agents still require an explicit user-chosen name.",
      "Use recover --name <displayName> to reopen a previously known offline agent under the same display name before routing or transferring work to it.",
      "Use connect --session <id|handle> --name <displayName> to register one Codex / Claude / local AI terminal session into the running router.",
      "Use agents list to inspect current live names before choosing a new unique display name.",
      "Use agents list or self status to inspect connected agents.",
      "Use self prompt-stable from an agent terminal when that session needs to refresh the mostly fixed routing/delegation prompt; per-ticket injection should then focus on dynamic ticket data and current conversation context.",
      "If the current agent should hand a task to another agent, call transfer --ticket <id> --to <name[,name...]> from that current terminal session.",
      "When a WeChat task is finished inside Codex, call reply --ticket <id> to send the final result back to WeChat.",
      "reply also supports --media <path|url> for official WeChat CDN upload and delivery of image / video / file attachments.",
      "All WeChat history is persisted as account-level JSONL under ~/.weixin-agent/history/<account>.jsonl, and each line carries its own conversationId.",
      "Use events tail or status to observe the running router and connected agents.",
    ],
    conventions: {
      transport: "stdout JSON by default; commands that intentionally return raw prompt text document that exception explicitly",
      errors: {
        ok: false,
        error: {
          code: "STRING_CODE",
          message: "Human-readable message",
          details: "Optional structured details",
        },
      },
      maturity: {
        implemented: "Command is usable now.",
        prototype: "Command exists, but part of the flow is still planned.",
        planned: "Command contract is reserved; functionality is not implemented.",
      },
    },
    state: {
      stateDir: resolveStateDir(),
      weixinAccountsIndexPath: resolveWeixinAccountsIndexPath(),
      weixinAccountsDir: resolveWeixinAccountsDir(),
      agentStateDir: resolveAgentStateDir(),
      agentConfigPath: resolveAgentConfigPath(),
      agentRuntimePath: resolveAgentRuntimePath(),
      legacyAgentStateDir: resolveLegacyAgentStateDir(),
      legacyAgentRuntimePath: resolveLegacyAgentRuntimePath(),
      agentAgentsDir: resolveAgentAgentsDir(),
      agentTicketsDir: resolveAgentTicketsDir(),
      agentConversationRoutesDir: resolveAgentConversationRoutesDir(),
      agentConversationHistoryDir: resolveAgentConversationHistoryDir(),
      accountHistoryExamplePath: resolveAgentAccountHistoryPath("<account-id>"),
      agentEventsPath: resolveAgentEventsPath(),
      agentBridgeLogPath: resolveAgentBridgeLogPath(),
      agentRouterLogPath: resolveAgentRouterLogPath(),
      agentConnectionLogExamplePath: resolveAgentConnectionLogPath("<agent-id>"),
      codexStateDir: resolveCodexStateDir(),
      codexSessionIndexPath: resolveCodexSessionIndexPath(),
    },
    bridgeModel: {
      primaryTarget: "multi-agent-router",
      defaultMode: "router + connected-agent-sessions",
      sources: ["local-terminal-agents", "wechat"],
      sessionPolicy: "single-flight per agent",
      responseRouting: "if zero live agents are online, the router may auto-spawn one default agent terminal first; if no explicit @agent-name is provided for that first spawn, it defaults to 元宝一号; if a WeChat message starts with @agent-name then route strictly to that target; otherwise fall back to the recent agent remembered for that WeChat conversation, then to the latest connected live agent; the current terminal agent may also transfer a pending ticket to one or more other connected agents",
      transportCapabilities: {
        inbound: ["wechat.text", "wechat.image", "wechat.voice", "wechat.file", "wechat.video"],
        outbound: ["wechat.text", "wechat.media.image", "wechat.media.video", "wechat.media.file"],
      },
    },
    commands: {
      spec: {
        maturity: "implemented",
        usage: "weixin-agent spec [--compact]",
        purpose: "Print the machine-readable command contract.",
      },
      doctor: {
        maturity: "implemented",
        usage: "weixin-agent doctor [--compact]",
        purpose: "Check local prerequisites and known state.",
      },
      status: {
        maturity: "implemented",
        usage: "weixin-agent status [--compact]",
        purpose: "Show selected account, config defaults, and runtime state.",
      },
      account: {
        purpose: "Inspect and manage local WeChat account state.",
        subcommands: {
          list: {
            maturity: "implemented",
            usage: "weixin-agent account list [--compact]",
            purpose: "List locally known WeChat accounts from ~/.weixin-agent/accounts/.",
          },
          show: {
            maturity: "implemented",
            usage: "weixin-agent account show [--account <id>] [--compact]",
            purpose: "Show one locally known account.",
          },
          use: {
            maturity: "implemented",
            usage: "weixin-agent account use <id> [--compact]",
            purpose: "Set the default account used by weixin-agent.",
          },
          remove: {
            maturity: "implemented",
            usage: "weixin-agent account remove <id> [--compact]",
            purpose: "Remove one local account credential file and index entry.",
          },
          login: {
            maturity: "implemented",
            usage: "weixin-agent account login [--base-url <url>] [--timeout-ms <n>] [--print-only] [--open-browser] [--no-open-browser] [--compact]",
            purpose: "Start QR login against the WeChat bot channel, render a scannable terminal QR code, and persist the local account token on success.",
          },
        },
      },
      config: {
        purpose: "Read and write local weixin-agent config values.",
        subcommands: {
          get: {
            maturity: "implemented",
            usage: "weixin-agent config get [<key>] [--compact]",
            purpose: "Read the full config or one key.",
          },
          set: {
            maturity: "implemented",
            usage: "weixin-agent config set <key> <value> [--compact]",
            purpose: "Update one local config key.",
          },
        },
      },
      events: {
        purpose: "Read the local structured event stream.",
        subcommands: {
          tail: {
            maturity: "implemented",
            usage: "weixin-agent events tail [--lines <n>] [--compact]",
            purpose: "Read the most recent structured events written by weixin-agent.",
          },
        },
      },
      start: {
        maturity: "implemented",
        usage: "weixin-agent start [--account <id>] [--cwd <path>] [--foreground] [--dry-run]",
        purpose: "Start the global WeChat router daemon. This is allowed even when zero agent sessions are connected.",
      },
      spawn: {
        maturity: "implemented",
        usage: "weixin-agent spawn [codex|claude|custom] --name <displayName> [--app iterm2|terminal] [--command <cmd>] [--cwd <path>] [--compact]",
        purpose: "Open a new terminal session, run the requested AI CLI command there, and connect that new terminal into the running router using an explicit user-chosen display name.",
      },
      recover: {
        maturity: "implemented",
        usage: "weixin-agent recover --name <displayName> [--app iterm2|terminal] [--command <cmd>] [--cwd <path>] [--compact]",
        purpose: "Reopen a previously known offline agent under the same display name and reconnect it into the router when recovery information is available.",
      },
      connect: {
        maturity: "implemented",
        usage: "weixin-agent connect [--session <id|handle>] [--app iterm2|terminal] [--kind codex|claude|custom] --name <displayName> [--cwd <path>] [--foreground] [--dry-run]",
        purpose: "Connect one local terminal AI session into the running router using an explicit full display name. The CLI never auto-generates the name; duplicate live names are rejected.",
      },
      disconnect: {
        maturity: "implemented",
        usage: "weixin-agent disconnect [--agent <id> | --session <id|handle> | --name <displayName>] [--force] [--compact]",
        purpose: "Disconnect one connected agent session from the router.",
      },
      agents: {
        purpose: "Inspect connected and historical agent registrations.",
        subcommands: {
          list: {
            maturity: "implemented",
            usage: "weixin-agent agents list [--all] [--compact]",
            purpose: "List live agents by default, or all known agent records with --all.",
          },
        },
      },
      rename: {
        purpose: "Rename the global default template or one connected agent.",
        subcommands: {
          template: {
            maturity: "implemented",
            usage: "weixin-agent rename template <template-with-{n}> [--compact]",
            purpose: "Update the stored naming template in ~/.weixin-agent/config.json. This is useful for external orchestrators or explicit naming workflows that expand {n}.",
          },
          agent: {
            maturity: "implemented",
            usage: "weixin-agent rename agent [--agent <id> | --session <id|handle> | --current-name <displayName>] --to <displayName> [--compact]",
            purpose: "Rename one connected agent by id, session, or current display name using an explicit full display name. Duplicate live names are rejected.",
          },
        },
      },
      self: {
        purpose: "Operate on the current terminal session's own agent registration.",
        subcommands: {
          status: {
            maturity: "implemented",
            usage: "weixin-agent self status [--compact]",
            purpose: "Show the connected agent record for the current terminal session, if any.",
          },
          "prompt-stable": {
            maturity: "implemented",
            usage: "weixin-agent self prompt-stable [--json] [--compact]",
            purpose: "Print the mostly fixed routing/delegation prompt for the current connected agent session. Raw text is printed by default; use --json to wrap it in normal CLI JSON output.",
          },
          rename: {
            maturity: "implemented",
            usage: "weixin-agent self rename --name <displayName> [--compact]",
            purpose: "Rename the current agent using an explicit full display name. Duplicate live names are rejected.",
          },
          disconnect: {
            maturity: "implemented",
            usage: "weixin-agent self disconnect [--force] [--compact]",
            purpose: "Disconnect the current terminal session from the router.",
          },
        },
      },
      reply: {
        maturity: "implemented",
        usage: "weixin-agent reply --ticket <id> [--message <text> | --stdin] [--media <path|url> | --image <path|url>] [--compact]",
        purpose: "Send the final result for one pending WeChat ticket back to the originating WeChat conversation. Supports text-only replies and official WeChat CDN media delivery for image / video / file attachments. The text portion is automatically prefixed with the replying agent identity.",
      },
      transfer: {
        maturity: "implemented",
        usage: "weixin-agent transfer --ticket <id> --to <displayName[,displayName...]> [--message <text> | --stdin] [--compact]",
        purpose: "Hand off one currently pending ticket from the current agent terminal session to one or more other connected agents. Single-target transfer updates the conversation's recent-agent memory to that target immediately.",
      },
      stop: {
        maturity: "implemented",
        usage: "weixin-agent stop [--compact]",
        purpose: "Stop every currently running global router daemon that this CLI can detect, including legacy .openclaw router runtimes.",
      },
      bridge: {
        purpose: "Plan and manage the local bridge controller.",
        subcommands: {
          status: {
            maturity: "implemented",
            usage: "weixin-agent bridge status [--compact]",
            purpose: "Show the known runtime state file, if any.",
          },
          start: {
            maturity: "prototype",
            usage: "weixin-agent bridge start [--attach current-codex] [--mode terminal-inject|direct-thread] [--app iterm2|terminal] [--session <id|handle>] [--account <id>] [--thread-id <id>] [--cwd <path>] [--foreground] [--dry-run]",
            purpose: "Legacy prototype path for the older single-session bridge and app-server observation flow.",
          },
          stop: {
            maturity: "implemented",
            usage: "weixin-agent bridge stop [--compact]",
            purpose: "Request the local bridge daemon to stop and update runtime state.",
          },
        },
      },
    },
  };
}
