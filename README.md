# weixin-agent

`weixin-agent` is a new CLI project for routing one WeChat account into zero or more local AI terminal workflows.

This project is intentionally separate from `../weixin-agent-sdk-main`.

The current primary design target is:

```text
WeChat
  <-> weixin-agent router
  <-> connected AI terminal sessions
  <-> local terminals
```

That is different from the existing ACP-only model:

```text
WeChat
  <-> bridge
  <-> spawned codex-acp
  <-> separate Codex backend
```

## Current Scope

This repository currently provides:

- A machine-readable `spec` command
- Local state/config/account inspection commands
- Interactive QR login that persists WeChat bot credentials locally
- A working `start` runtime for one global WeChat router daemon
- Automatic on-demand agent spawning when the router receives a WeChat message and currently has zero live agents
- A working `connect --session` flow for registering multiple Codex / Claude / local AI terminal sessions
- A working `spawn` flow for opening a new terminal session, starting `codex` / `claude`, and connecting that fresh terminal into the router
- Explicit per-agent naming, duplicate prevention, specific-agent rename, self rename, and optional naming-template storage for external orchestrators
- Per-WeChat-conversation recent-agent memory, with strict `@agent-name` override and latest-connected fallback
- Agent-side `transfer --ticket` handoff so one connected agent can move a pending ticket to one or more other connected agents
- A ticket-based `reply --ticket` flow so the same terminal session can send the final answer back to WeChat
- Terminal session discovery for iTerm2 and Terminal on macOS
- Native-terminal plus TTY-based prompt injection so WeChat tasks can be submitted into the targeted agent session

This repository still has one important limitation:

- The explicit `reply --ticket` step is still required for the terminal agent to send the final answer back to WeChat.
- The older `bridge ...` app-server observation path still exists only as a prototype and should not be treated as the primary workflow.

The primary router model is now:

```text
WeChat text
  -> weixin-agent router daemon
  -> if zero live agents: auto-spawn one default terminal agent first
  -> strict-mention router / recent-agent router / latest-connected fallback
  -> wrapped task prompt injected into one target agent session
  -> that same terminal AI works in place
  -> or that same terminal AI runs `weixin-agent transfer --ticket ...`
  -> that same terminal AI runs `weixin-agent reply --ticket ...`
  -> weixin-agent sends the final result back to WeChat
```

Architecture notes:

- [Architecture](./docs/architecture.md)

## Commands

```bash
weixin-agent spec
weixin-agent doctor
weixin-agent status

weixin-agent start
weixin-agent stop
weixin-agent spawn codex --name 豆包2号
weixin-agent recover --name 豆包2号

weixin-agent connect --session <id|handle> --name <displayName>
weixin-agent disconnect --session <id|handle>
weixin-agent rename template "豆包{n}号"
weixin-agent rename agent --current-name 豆包1号 --to 豆包2号
weixin-agent agents list
weixin-agent self status
weixin-agent self rename --name <displayName>
weixin-agent self disconnect

weixin-agent reply --ticket <id> --message "..."
weixin-agent reply --ticket <id> --stdin
weixin-agent transfer --ticket <id> --to "豆包2号"
weixin-agent transfer --ticket <id> --to "豆包1号,豆包2号"

weixin-agent account list
weixin-agent account login
weixin-agent account show
weixin-agent account use <id>
weixin-agent account remove <id>

weixin-agent config get
weixin-agent config set <key> <value>

weixin-agent events tail

weixin-agent bridge status
weixin-agent bridge start --attach current-codex --dry-run
weixin-agent bridge stop
```

## Design Notes

- All local state lives under `~/.weixin-agent/`
- User-facing defaults are stored in `~/.weixin-agent/config.json`
- WeChat account files are stored in `~/.weixin-agent/accounts/`
- WeChat history is appended as account-level JSONL under `~/.weixin-agent/history/<account>.jsonl`, and each line carries its own `conversationId`
- `start` is the primary router startup flow
- `start` can run with zero connected agents, and the router may auto-spawn one default agent when the first WeChat message arrives; if the user did not explicitly provide a name, that first agent defaults to `元宝一号`
- `spawn` is the primary way for one existing agent or a user to proactively create a new named Codex / Claude terminal session, and later agents still require an explicit user-chosen name
- `recover --name` can reopen a previously known offline agent under the same display name before routing or transferring work to it
- `connect --session` is the primary agent attach flow
- `start` and `connect` are intentionally separate; the router can run with zero connected agents
- `connect --name` is mandatory; the CLI never auto-generates display names
- `rename agent --to` and `self rename --name` also require explicit full display names
- Live agent display names must be unique; if a desired name is already taken, the caller should inspect `weixin-agent agents list` and choose another full name
- `rename template` updates the stored naming template in `~/.weixin-agent/config.json`, for workflows that intentionally expand `{n}`
- If a message starts with `@agent-name`, router uses strict routing
- If zero live agents exist when a WeChat message arrives, router first auto-spawns one default agent terminal and then routes the message into that new session; without an explicit user-chosen name, that first agent defaults to `元宝一号`
- If a conversation's remembered agent or an explicitly mentioned `@agent-name` is currently offline, router may first try to reopen that agent under the same display name and then continue routing
- If a message does not start with `@agent-name`, router first tries the recent agent remembered for that WeChat conversation, and then falls back to the latest connected live agent
- `transfer --ticket` lets the current agent hand a pending task to one or more other connected agents
- `reply --ticket` is the explicit return path from Codex back to WeChat, and the outgoing WeChat text is automatically prefixed with the replying agent identity
- Each connected AI session should process one WeChat ticket at a time
