import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { CLIError } from "./errors.mjs";

const FIELD_SEPARATOR = String.fromCharCode(31);
const SUBMIT_DELAY_MS = 40;

const APP_ALIASES = Object.freeze({
  iterm2: "iterm2",
  iterm: "iterm2",
  terminal: "terminal",
  appleterminal: "terminal",
  "apple-terminal": "terminal",
  "apple_terminal": "terminal",
});

const PROVIDERS = Object.freeze({
  iterm2: {
    app: "iterm2",
    displayName: "iTerm2",
    bundleId: "com.googlecode.iterm2",
  },
  terminal: {
    app: "terminal",
    displayName: "Terminal",
    bundleId: "com.apple.Terminal",
  },
});

const ITERM2_LIST_SCRIPT = `
on replaceText(findText, replaceWith, inputText)
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set parts to every text item of inputText
  set AppleScript's text item delimiters to replaceWith
  set outputText to parts as text
  set AppleScript's text item delimiters to oldDelims
  return outputText
end replaceText

on sanitizeText(inputValue)
  if inputValue is missing value then
    return ""
  end if

  set textValue to inputValue as text
  set textValue to my replaceText(character id 31, " ", textValue)
  set textValue to my replaceText(return, " ", textValue)
  set textValue to my replaceText(linefeed, " ", textValue)
  return textValue
end sanitizeText

if application id "${PROVIDERS.iterm2.bundleId}" is not running then
  error "iTerm2 is not running" number 1001
end if

tell application id "${PROVIDERS.iterm2.bundleId}"
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set outLines to {}
  set frontWindowId to missing value

  if (count of windows) is greater than 0 then
    set frontWindowId to id of current window
  end if

  repeat with wi from 1 to count of windows
    set w to window wi
    set currentTabSessionId to id of current session of current tab of w
    set isFrontmost to "0"
    if frontWindowId is not missing value and (id of w as text) is (frontWindowId as text) then
      set isFrontmost to "1"
    end if

    copy ("W" & character id 31 & (id of w as text) & character id 31 & (wi as text) & character id 31 & isFrontmost & character id 31 & currentTabSessionId) to end of outLines

    repeat with ti from 1 to count of tabs of w
      set t to tab ti of w
      set tabCurrentSessionId to id of current session of t
      set isCurrentTab to "0"
      if tabCurrentSessionId is currentTabSessionId then
        set isCurrentTab to "1"
      end if

      copy ("T" & character id 31 & (ti as text) & character id 31 & isCurrentTab & character id 31 & tabCurrentSessionId & character id 31 & my sanitizeText(title of t)) to end of outLines

      repeat with si from 1 to count of sessions of t
        set s to session si of t
        set sessionTty to ""
        set isCurrentSession to "0"

        try
          set sessionTty to tty of s
        end try

        if (id of s) is tabCurrentSessionId then
          set isCurrentSession to "1"
        end if

        copy ("S" & character id 31 & (si as text) & character id 31 & isCurrentSession & character id 31 & (id of s) & character id 31 & my sanitizeText(sessionTty) & character id 31 & my sanitizeText(name of s)) to end of outLines
      end repeat
    end repeat
  end repeat

  set resultText to outLines as text
  set AppleScript's text item delimiters to oldDelims
  return resultText
end tell
`;

const ITERM2_SEND_SCRIPT = `
on run argv
  if (count of argv) is not 3 then
    error "expected session id, text, and newline flag" number 1002
  end if

  set targetSessionId to item 1 of argv
  set inputText to item 2 of argv
  set newlineFlag to item 3 of argv
  set shouldSendNewline to true
  if newlineFlag is "false" then
    set shouldSendNewline to false
  end if

  if application id "${PROVIDERS.iterm2.bundleId}" is not running then
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDERS.iterm2.bundleId}"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is targetSessionId then
            tell s to write text inputText newline shouldSendNewline
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell

  error "session not found" number 1003
end run
`;

const ITERM2_CAPTURE_SCRIPT = `
on run argv
  if (count of argv) is not 1 then
    error "expected session id" number 1002
  end if

  set targetSessionId to item 1 of argv

  if application id "${PROVIDERS.iterm2.bundleId}" is not running then
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDERS.iterm2.bundleId}"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is targetSessionId then
            return contents of s
          end if
        end repeat
      end repeat
    end repeat
  end tell

  error "session not found" number 1003
end run
`;

const ITERM2_FOCUS_SCRIPT = `
on run argv
  if (count of argv) is not 3 then
    error "expected window id, tab index, and session index" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer
  set targetSessionIndex to item 3 of argv as integer

  if application id "${PROVIDERS.iterm2.bundleId}" is not running then
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDERS.iterm2.bundleId}"
    tell window id targetWindowId to select
    tell tab targetTabIndex of window id targetWindowId to select
    tell session targetSessionIndex of tab targetTabIndex of window id targetWindowId to select
    activate
    return (id of current window as text)
  end tell
end run
`;

const ITERM2_PRESS_SCRIPT = `
on run argv
  if (count of argv) is not 4 then
    error "expected window id, tab index, session index, and key" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer
  set targetSessionIndex to item 3 of argv as integer
  set targetKey to item 4 of argv

  if application id "${PROVIDERS.iterm2.bundleId}" is not running then
    error "iTerm2 is not running" number 1001
  end if

  tell application id "${PROVIDERS.iterm2.bundleId}"
    tell window id targetWindowId to select
    tell tab targetTabIndex of window id targetWindowId to select
    tell session targetSessionIndex of tab targetTabIndex of window id targetWindowId to select
    activate
  end tell

  delay 0.05

  tell application "System Events"
    if targetKey is "enter" then
      key code 76
      return "ok"
    end if

    if targetKey is "return" then
      key code 36
      return "ok"
    end if
  end tell

  error "unsupported key" number 1004
end run
`;

const ITERM2_CREATE_SCRIPT = `
on run argv
  if (count of argv) is not 1 then
    error "expected startup command" number 1002
  end if

  set startupCommand to item 1 of argv

  tell application id "${PROVIDERS.iterm2.bundleId}"
    activate

    if (count of windows) is 0 then
      create window with default profile
    else
      tell current window
        create tab with default profile
      end tell
    end if

    delay 0.2

    set s to current session of current tab of current window
    if startupCommand is not "" then
      tell s to write text startupCommand
    end if

    return (id of s as text)
  end tell
end run
`;

const TERMINAL_LIST_SCRIPT = `
on replaceText(findText, replaceWith, inputText)
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set parts to every text item of inputText
  set AppleScript's text item delimiters to replaceWith
  set outputText to parts as text
  set AppleScript's text item delimiters to oldDelims
  return outputText
end replaceText

on sanitizeText(inputValue)
  if inputValue is missing value then
    return ""
  end if

  set textValue to inputValue as text
  set textValue to my replaceText(character id 31, " ", textValue)
  set textValue to my replaceText(return, " ", textValue)
  set textValue to my replaceText(linefeed, " ", textValue)
  return textValue
end sanitizeText

on lastProcessName(processList)
  try
    if (count of processList) is greater than 0 then
      return item -1 of processList as text
    end if
  end try

  return ""
end lastProcessName

if application id "${PROVIDERS.terminal.bundleId}" is not running then
  error "Terminal is not running" number 1001
end if

tell application id "${PROVIDERS.terminal.bundleId}"
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set outLines to {}
  set frontWindowId to missing value

  if (count of windows) is greater than 0 then
    set frontWindowId to id of front window
  end if

  repeat with wi from 1 to count of windows
    set w to window wi
    set currentSessionId to ""
    set isFrontmost to "0"

    if frontWindowId is not missing value and (id of w as text) is (frontWindowId as text) then
      set isFrontmost to "1"
    end if

    repeat with ti from 1 to number of tabs of w
      set t to tab ti of w
      if selected of t then
        try
          set currentSessionId to tty of t
        end try

        if currentSessionId is "" then
          set currentSessionId to ("window:" & (id of w as text) & ":tab:" & (ti as text))
        end if
      end if
    end repeat

    copy ("W" & character id 31 & (id of w as text) & character id 31 & (wi as text) & character id 31 & isFrontmost & character id 31 & currentSessionId) to end of outLines

    repeat with ti from 1 to number of tabs of w
      set t to tab ti of w
      set isCurrentTab to "0"
      set sessionTty to ""
      set sessionId to ""
      set sessionName to ""
      set tabTitle to ""

      if selected of t then
        set isCurrentTab to "1"
      end if

      try
        set sessionTty to tty of t
      end try

      if sessionTty is not "" then
        set sessionId to sessionTty
      else
        set sessionId to ("window:" & (id of w as text) & ":tab:" & (ti as text))
      end if

      set sessionName to my sanitizeText(my lastProcessName(processes of t))
      set tabTitle to my sanitizeText(custom title of t)

      if tabTitle is "" then
        if sessionName is not "" then
          set tabTitle to sessionName
        else
          set tabTitle to sessionId
        end if
      end if

      copy ("T" & character id 31 & (ti as text) & character id 31 & isCurrentTab & character id 31 & sessionId & character id 31 & tabTitle) to end of outLines
      copy ("S" & character id 31 & "1" & character id 31 & isCurrentTab & character id 31 & sessionId & character id 31 & my sanitizeText(sessionTty) & character id 31 & sessionName) to end of outLines
    end repeat
  end repeat

  set resultText to outLines as text
  set AppleScript's text item delimiters to oldDelims
  return resultText
end tell
`;

const TERMINAL_TYPE_SCRIPT = `
on run argv
  if (count of argv) is not 3 then
    error "expected window id, tab index, and text" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer
  set inputText to item 3 of argv

  if application id "${PROVIDERS.terminal.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDERS.terminal.bundleId}"
    set selected of tab targetTabIndex of window id targetWindowId to true
    activate
  end tell

  delay 0.05

  set previousClipboard to missing value
  try
    set previousClipboard to the clipboard
  end try

  set the clipboard to inputText

  tell application "System Events"
    keystroke "v" using command down
  end tell

  delay 0.05

  if previousClipboard is not missing value then
    try
      set the clipboard to previousClipboard
    end try
  end if

  return "ok"
end run
`;

const TERMINAL_FOCUS_SCRIPT = `
on run argv
  if (count of argv) is not 2 then
    error "expected window id and tab index" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer

  if application id "${PROVIDERS.terminal.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDERS.terminal.bundleId}"
    set selected of tab targetTabIndex of window id targetWindowId to true
    activate
    return (id of front window as text)
  end tell
end run
`;

const TERMINAL_PRESS_SCRIPT = `
on run argv
  if (count of argv) is not 3 then
    error "expected window id, tab index, and key" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer
  set targetKey to item 3 of argv

  if application id "${PROVIDERS.terminal.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDERS.terminal.bundleId}"
    set selected of tab targetTabIndex of window id targetWindowId to true
    activate
  end tell

  delay 0.05

  tell application "System Events"
    if targetKey is "enter" then
      key code 76
      return "ok"
    end if

    if targetKey is "return" then
      key code 36
      return "ok"
    end if
  end tell

  error "unsupported key" number 1004
end run
`;

const TERMINAL_CAPTURE_SCRIPT = `
on run argv
  if (count of argv) is not 2 then
    error "expected window id and tab index" number 1002
  end if

  set targetWindowId to item 1 of argv
  set targetTabIndex to item 2 of argv as integer

  if application id "${PROVIDERS.terminal.bundleId}" is not running then
    error "Terminal is not running" number 1001
  end if

  tell application id "${PROVIDERS.terminal.bundleId}"
    return contents of tab targetTabIndex of window id targetWindowId
  end tell
end run
`;

const TERMINAL_CREATE_SCRIPT = `
on run argv
  if (count of argv) is not 1 then
    error "expected startup command" number 1002
  end if

  set startupCommand to item 1 of argv

  tell application id "${PROVIDERS.terminal.bundleId}"
    activate

    if startupCommand is "" then
      do script ""
    else
      do script startupCommand
    end if

    delay 0.3

    set targetWindow to front window
    set targetTab to selected tab of targetWindow
    set targetTty to ""
    try
      set targetTty to tty of targetTab
    end try

    if targetTty is not "" then
      return targetTty
    end if

    return ("window:" & (id of targetWindow as text) & ":tab:1")
  end tell
end run
`;

function normalizeAppName(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  return APP_ALIASES[normalized] ?? null;
}

function makeSnapshot(provider, { running = true } = {}) {
  return {
    ok: true,
    app: provider.app,
    displayName: provider.displayName,
    bundleId: provider.bundleId,
    running,
    windows: [],
    counts: {
      windows: 0,
      tabs: 0,
      sessions: 0,
    },
  };
}

function parseBoolFlag(value) {
  return value === "1";
}

function toNullableText(value) {
  return value === "" ? null : value;
}

function parseSnapshot(provider, raw) {
  const snapshot = makeSnapshot(provider);
  if (!raw) {
    return snapshot;
  }

  let currentWindow = null;
  let currentTab = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const parts = line.split(FIELD_SEPARATOR);
    const recordType = parts[0];

    if (recordType === "W") {
      currentWindow = {
        app: provider.app,
        displayName: provider.displayName,
        bundleId: provider.bundleId,
        windowId: Number(parts[1]),
        windowIndex: Number(parts[2]),
        windowHandle: `${provider.app}:window:${parts[1]}`,
        isFrontmost: parseBoolFlag(parts[3]),
        currentTabSessionId: parts[4] || null,
        tabs: [],
      };
      currentTab = null;
      snapshot.windows.push(currentWindow);
      snapshot.counts.windows += 1;
      continue;
    }

    if (recordType === "T") {
      if (!currentWindow) {
        throw new CLIError("TERMINAL_SNAPSHOT_PARSE_ERROR", "Malformed terminal snapshot.");
      }

      currentTab = {
        tabIndex: Number(parts[1]),
        isCurrent: parseBoolFlag(parts[2]),
        currentSessionId: parts[3] || null,
        title: toNullableText(parts.slice(4).join(FIELD_SEPARATOR)),
        tabHandle: `${provider.app}:tab:${currentWindow.windowId}:${parts[1]}`,
        sessions: [],
      };
      currentWindow.tabs.push(currentTab);
      snapshot.counts.tabs += 1;
      continue;
    }

    if (recordType === "S") {
      if (!currentWindow || !currentTab) {
        throw new CLIError("TERMINAL_SNAPSHOT_PARSE_ERROR", "Malformed terminal snapshot.");
      }

      const sessionId = parts[3];
      currentTab.sessions.push({
        app: provider.app,
        displayName: provider.displayName,
        bundleId: provider.bundleId,
        windowId: currentWindow.windowId,
        windowIndex: currentWindow.windowIndex,
        windowHandle: currentWindow.windowHandle,
        isFrontmostWindow: currentWindow.isFrontmost,
        tabIndex: currentTab.tabIndex,
        tabTitle: currentTab.title,
        isCurrentTab: currentTab.isCurrent,
        tabHandle: currentTab.tabHandle,
        sessionIndex: Number(parts[1]),
        sessionId,
        tty: toNullableText(parts[4]),
        name: toNullableText(parts.slice(5).join(FIELD_SEPARATOR)),
        isCurrentSession: parseBoolFlag(parts[2]),
        handle: `${provider.app}:session:${sessionId}`,
      });
      snapshot.counts.sessions += 1;
      continue;
    }
  }

  return snapshot;
}

function flattenSessions(snapshot) {
  return snapshot.windows.flatMap((window) =>
    window.tabs.flatMap((tab) => tab.sessions.map((session) => ({
      ...session,
      windowId: window.windowId,
      windowIndex: window.windowIndex,
      isFrontmostWindow: window.isFrontmost,
      tabIndex: tab.tabIndex,
      tabTitle: tab.title,
      isCurrentTab: tab.isCurrent,
    }))),
  );
}

function mapAppleScriptError(message) {
  if (message.includes("Not authorized") || message.includes("(-1743)")) {
    return new CLIError("TERMINAL_AUTOMATION_DENIED", "Automation permission for terminal control was denied.", {
      details: message,
    });
  }

  if (message.includes("assistive access") || message.includes("(-1719)")) {
    return new CLIError(
      "TERMINAL_ACCESSIBILITY_DENIED",
      "Accessibility permission is required for terminal keyboard automation.",
      {
        details: message,
      },
    );
  }

  if (message.includes("session not found")) {
    return new CLIError("TERMINAL_SESSION_NOT_FOUND", "Terminal session not found.");
  }

  return new CLIError("TERMINAL_APPLESCRIPT_FAILED", "AppleScript execution failed.", {
    details: message,
  });
}

function runAppleScript(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new CLIError("OSASCRIPT_NOT_FOUND", "osascript is not available."));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }
      reject(mapAppleScriptError(stderr.trim() || stdout.trim() || "AppleScript execution failed"));
    });

    child.stdin.end(script);
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function requireDarwinPlatform() {
  if (process.platform !== "darwin") {
    throw new CLIError("UNSUPPORTED_PLATFORM", "Terminal injection is currently implemented for macOS only.", {
      platform: process.platform,
      supportedPlatforms: ["darwin"],
    });
  }
}

function requireProvider(app) {
  const normalizedApp = normalizeAppName(app);
  if (!normalizedApp || !PROVIDERS[normalizedApp]) {
    throw new CLIError("UNSUPPORTED_TERMINAL_APP", `Unsupported terminal app: ${String(app ?? "")}`, {
      app,
      supportedApps: Object.keys(PROVIDERS),
    });
  }
  return PROVIDERS[normalizedApp];
}

async function getFrontmostApp() {
  requireDarwinPlatform();

  try {
    const [bundleId, name] = await Promise.all([
      runAppleScript(
        'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
      ),
      runAppleScript(
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ),
    ]);

    const provider = Object.values(PROVIDERS).find((entry) => entry.bundleId === bundleId);
    return {
      app: provider?.app ?? null,
      displayName: provider?.displayName ?? name ?? null,
      bundleId,
    };
  } catch {
    return null;
  }
}

async function getProviderSnapshot(provider) {
  const runningScript = `return (application id "${provider.bundleId}" is running) as text`;
  const running = (await runAppleScript(runningScript)).trim() === "true";
  if (!running) {
    return makeSnapshot(provider, { running: false });
  }

  if (provider.app === "iterm2") {
    return parseSnapshot(provider, await runAppleScript(ITERM2_LIST_SCRIPT));
  }

  if (provider.app === "terminal") {
    return parseSnapshot(provider, await runAppleScript(TERMINAL_LIST_SCRIPT));
  }

  return makeSnapshot(provider, { running: false });
}

export async function getTerminalSnapshot({ app = null } = {}) {
  requireDarwinPlatform();

  const selectedProviders = app
    ? [requireProvider(app)]
    : Object.values(PROVIDERS);

  const frontmostApp = await getFrontmostApp();
  const providerSnapshots = [];

  for (const provider of selectedProviders) {
    providerSnapshots.push(await getProviderSnapshot(provider));
  }

  return {
    ok: true,
    source: "weixin-agent",
    generatedAt: new Date().toISOString(),
    frontmostApp,
    counts: {
      apps: providerSnapshots.length,
      runningApps: providerSnapshots.filter((entry) => entry.running).length,
      windows: providerSnapshots.reduce((sum, entry) => sum + entry.counts.windows, 0),
      tabs: providerSnapshots.reduce((sum, entry) => sum + entry.counts.tabs, 0),
      sessions: providerSnapshots.reduce((sum, entry) => sum + entry.counts.sessions, 0),
    },
    apps: providerSnapshots.map((entry) => ({
      app: entry.app,
      displayName: entry.displayName,
      bundleId: entry.bundleId,
      running: entry.running,
      counts: entry.counts,
    })),
    windows: providerSnapshots.flatMap((entry) => entry.windows),
  };
}

export async function resolveCurrentTerminalTarget({
  app = null,
  session = null,
} = {}) {
  const normalizedApp = app ? normalizeAppName(app) : null;
  if (app && !normalizedApp) {
    throw new CLIError("UNSUPPORTED_TERMINAL_APP", `Unsupported terminal app: ${String(app)}`, {
      app,
      supportedApps: Object.keys(PROVIDERS),
    });
  }

  const snapshot = await getTerminalSnapshot({ app: normalizedApp });
  const sessions = flattenSessions(snapshot);

  if (session) {
    const matches = sessions.filter((entry) => entry.sessionId === session || entry.handle === session);
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new CLIError("TERMINAL_SESSION_AMBIGUOUS", "Terminal session selector is ambiguous.", {
        session,
        matches,
      });
    }
    throw new CLIError("TERMINAL_SESSION_NOT_FOUND", "Terminal session was not found.", {
      session,
    });
  }

  let candidates = sessions.filter(
    (entry) => entry.isFrontmostWindow && entry.isCurrentTab && entry.isCurrentSession,
  );

  if (!normalizedApp && snapshot.frontmostApp?.app) {
    const frontmostCandidates = candidates.filter((entry) => entry.app === snapshot.frontmostApp.app);
    if (frontmostCandidates.length > 0) {
      candidates = frontmostCandidates;
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new CLIError("TERMINAL_SESSION_REQUIRED", "No current terminal session could be resolved.", {
      recommendation: "Run bridge start in the frontmost Codex terminal, or pass --session explicitly.",
      frontmostApp: snapshot.frontmostApp,
    });
  }

  throw new CLIError("TERMINAL_SESSION_AMBIGUOUS", "Multiple terminal sessions matched the current selector.", {
    matches: candidates,
  });
}

export async function sendTextToTerminalTarget(target, text, { newline = true } = {}) {
  requireDarwinPlatform();
  requireProvider(target?.app);

  if (typeof target?.tty !== "string" || target.tty.trim() === "") {
    throw new CLIError("TERMINAL_TTY_REQUIRED", "The target terminal session does not expose a writable tty.", {
      target,
    });
  }

  const ttyPath = target.tty.trim();
  let handle;
  let submitMethod = null;

  try {
    handle = await fs.open(ttyPath, "w");
    await handle.writeFile(text);

    if (newline) {
      await sleep(SUBMIT_DELAY_MS);
      try {
        await pressKeyOnTerminalTarget(target, "enter");
        submitMethod = "key.enter";
      } catch {
        await handle.writeFile("\r");
        submitMethod = "tty.cr";
      }
    }
  } catch (error) {
    throw new CLIError("TERMINAL_TTY_WRITE_FAILED", "Failed to write input into the target terminal tty.", {
      tty: ttyPath,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await handle?.close().catch(() => {});
  }

  return {
    ok: true,
    method: newline ? `tty.write_then_submit.${submitMethod ?? "tty.cr"}` : "tty.write",
    sessionId: target.sessionId,
    tty: ttyPath,
    newline,
    submitMethod,
  };
}

export async function sendNativeTextToTerminalTarget(target, text, { newline = true } = {}) {
  requireDarwinPlatform();
  const provider = requireProvider(target?.app);

  if (provider.app === "iterm2") {
    await runAppleScript(ITERM2_SEND_SCRIPT, [
      String(target.sessionId),
      String(text),
      newline ? "true" : "false",
    ]);
    return {
      ok: true,
      method: newline ? "applescript.write_text.newline" : "applescript.write_text",
      sessionId: target.sessionId,
      newline,
    };
  }

  if (provider.app === "terminal") {
    await runAppleScript(TERMINAL_TYPE_SCRIPT, [
      String(target.windowId),
      String(target.tabIndex),
      String(text),
    ]);

    if (newline) {
      await runAppleScript(TERMINAL_PRESS_SCRIPT, [
        String(target.windowId),
        String(target.tabIndex),
        "enter",
      ]);
    }

    return {
      ok: true,
      method: newline ? "applescript.type_then_enter" : "applescript.type",
      sessionId: target.sessionId,
      newline,
    };
  }

  throw new CLIError("UNSUPPORTED_TERMINAL_APP", `Unsupported terminal app: ${provider.app}`);
}

export async function captureTerminalTarget(target) {
  requireDarwinPlatform();
  const provider = requireProvider(target?.app);

  if (provider.app === "iterm2") {
    return runAppleScript(ITERM2_CAPTURE_SCRIPT, [target.sessionId]);
  }

  if (provider.app === "terminal") {
    return runAppleScript(TERMINAL_CAPTURE_SCRIPT, [
      String(target.windowId),
      String(target.tabIndex),
    ]);
  }

  throw new CLIError("UNSUPPORTED_TERMINAL_APP", `Unsupported terminal app: ${provider.app}`);
}

export async function focusTerminalTarget(target) {
  requireDarwinPlatform();
  const provider = requireProvider(target?.app);

  if (provider.app === "iterm2") {
    return runAppleScript(ITERM2_FOCUS_SCRIPT, [
      String(target.windowId),
      String(target.tabIndex),
      String(target.sessionIndex),
    ]);
  }

  if (provider.app === "terminal") {
    return runAppleScript(TERMINAL_FOCUS_SCRIPT, [
      String(target.windowId),
      String(target.tabIndex),
    ]);
  }

  throw new CLIError("UNSUPPORTED_TERMINAL_APP", `Unsupported terminal app: ${provider.app}`);
}

export async function pressKeyOnTerminalTarget(target, key = "enter") {
  requireDarwinPlatform();
  const provider = requireProvider(target?.app);

  if (provider.app === "iterm2") {
    await runAppleScript(ITERM2_PRESS_SCRIPT, [
      String(target.windowId),
      String(target.tabIndex),
      String(target.sessionIndex),
      key,
    ]);
    return {
      ok: true,
      sessionId: target.sessionId,
      key,
      method: "applescript.key",
    };
  }

  if (provider.app === "terminal") {
    await runAppleScript(TERMINAL_PRESS_SCRIPT, [
      String(target.windowId),
      String(target.tabIndex),
      key,
    ]);
    return {
      ok: true,
      sessionId: target.sessionId,
      key,
      method: "applescript.key",
    };
  }

  throw new CLIError("UNSUPPORTED_TERMINAL_APP", `Unsupported terminal app: ${provider.app}`);
}

export async function launchTerminalSession({
  app,
  command = "",
  resolveTimeoutMs = 10_000,
  resolvePollMs = 200,
} = {}) {
  requireDarwinPlatform();
  const provider = requireProvider(app);
  const startupCommand = String(command ?? "");

  let sessionSelector = null;
  if (provider.app === "iterm2") {
    sessionSelector = await runAppleScript(ITERM2_CREATE_SCRIPT, [startupCommand]);
  } else if (provider.app === "terminal") {
    sessionSelector = await runAppleScript(TERMINAL_CREATE_SCRIPT, [startupCommand]);
  } else {
    throw new CLIError("UNSUPPORTED_TERMINAL_APP", `Unsupported terminal app: ${provider.app}`);
  }

  const deadline = Date.now() + Math.max(500, Number(resolveTimeoutMs) || 10_000);
  let lastError = null;
  let selectors = uniqueValues([
    String(sessionSelector ?? "").trim(),
  ]);

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const target = await resolveCurrentTerminalTarget({
          app: provider.app,
          session: selector,
        });
        return {
          ok: true,
          app: provider.app,
          command: startupCommand,
          sessionSelector: selector,
          target,
        };
      } catch (error) {
        lastError = error;
      }
    }

    await sleep(resolvePollMs);

    if (provider.app === "terminal") {
      try {
        const snapshot = await getTerminalSnapshot({ app: provider.app });
        const sessions = flattenSessions(snapshot)
          .sort((left, right) => {
            if (left.isFrontmostWindow !== right.isFrontmostWindow) {
              return right.isFrontmostWindow ? 1 : -1;
            }
            if (left.windowIndex !== right.windowIndex) {
              return right.windowIndex - left.windowIndex;
            }
            return right.tabIndex - left.tabIndex;
          });
        const latest = sessions[0] ?? null;
        selectors = uniqueValues([
          String(sessionSelector ?? "").trim(),
          latest?.sessionId ?? null,
          latest?.handle ?? null,
        ]);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw new CLIError("TERMINAL_SESSION_LAUNCH_FAILED", "A new terminal session was created, but its session handle could not be resolved in time.", {
    app: provider.app,
    command: startupCommand,
    sessionSelector,
    error: lastError instanceof Error ? lastError.message : String(lastError ?? ""),
  });
}
