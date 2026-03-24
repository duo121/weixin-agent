import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfigRouteTag } from "./accounts.mjs";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_ITEM_TYPE_TEXT = 1;
const MESSAGE_ITEM_TYPE_IMAGE = 2;
const MESSAGE_ITEM_TYPE_VOICE = 3;
const MESSAGE_ITEM_TYPE_FILE = 4;
const MESSAGE_ITEM_TYPE_VIDEO = 5;
const MESSAGE_STATE_FINISH = 2;

function readVersion() {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildBaseInfo() {
  return {
    channel_version: readVersion(),
  };
}

function buildHeaders({ accountId, token, body }) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
  };

  if (typeof token === "string" && token.trim() !== "") {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  const routeTag = loadConfigRouteTag(accountId);
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }

  return headers;
}

async function postJson({
  accountId,
  baseUrl,
  endpoint,
  token,
  payload,
  timeoutMs,
}) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders({
        accountId,
        token,
        body,
      }),
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${endpoint} failed: ${response.status} ${response.statusText} ${raw}`);
    }

    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

export async function getUpdates({
  accountId,
  baseUrl,
  token,
  getUpdatesBuf = "",
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
}) {
  try {
    return await postJson({
      accountId,
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      token,
      timeoutMs,
      payload: {
        get_updates_buf: getUpdatesBuf,
        base_info: buildBaseInfo(),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: getUpdatesBuf,
      };
    }
    throw error;
  }
}

export async function getUploadUrl({
  accountId,
  baseUrl,
  token,
  filekey,
  mediaType,
  toUserId,
  rawsize,
  rawfilemd5,
  filesize,
  thumbRawsize = null,
  thumbRawfilemd5 = null,
  thumbFilesize = null,
  noNeedThumb = true,
  aesKeyHex = null,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
}) {
  return postJson({
    accountId,
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    token,
    timeoutMs,
    payload: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      thumb_rawsize: thumbRawsize ?? undefined,
      thumb_rawfilemd5: thumbRawfilemd5 ?? undefined,
      thumb_filesize: thumbFilesize ?? undefined,
      no_need_thumb: noNeedThumb,
      aeskey: aesKeyHex ?? undefined,
      base_info: buildBaseInfo(),
    },
  });
}

export async function sendMessage({
  accountId,
  baseUrl,
  token,
  toUserId,
  contextToken,
  itemList,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
}) {
  if (!contextToken) {
    throw new Error("contextToken is required for WeChat replies.");
  }
  if (!Array.isArray(itemList) || itemList.length === 0) {
    throw new Error("itemList must contain at least one WeChat message item.");
  }

  const clientId = `wxagent-${Date.now()}-${crypto.randomUUID()}`;
  await postJson({
    accountId,
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token,
    timeoutMs,
    payload: {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: itemList,
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    },
  });

  return {
    messageId: clientId,
  };
}

export async function sendTextMessage({
  accountId,
  baseUrl,
  token,
  toUserId,
  contextToken,
  text,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
}) {
  return sendMessage({
    accountId,
    baseUrl,
    token,
    toUserId,
    contextToken,
    timeoutMs,
    itemList: text
      ? [
          {
            type: MESSAGE_ITEM_TYPE_TEXT,
            text_item: {
              text,
            },
          },
        ]
      : [],
  });
}

function trimmedString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizedDisplayUrl(value) {
  const text = trimmedString(value);
  if (!text) {
    return null;
  }
  if (/^(https?|file):\/\//i.test(text)) {
    return text;
  }
  return null;
}

function pickMediaObject(item) {
  return item?.image_item?.media
    ?? item?.voice_item?.media
    ?? item?.file_item?.media
    ?? item?.video_item?.media
    ?? null;
}

function normalizePositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function buildRefBodyFromItem(item) {
  const type = Number(item?.type ?? 0);

  if (type === MESSAGE_ITEM_TYPE_TEXT) {
    return trimmedString(item?.text_item?.text) || null;
  }

  if (type === MESSAGE_ITEM_TYPE_VOICE) {
    return trimmedString(item?.voice_item?.text) || "[语音]";
  }

  if (type === MESSAGE_ITEM_TYPE_FILE) {
    const fileName = trimmedString(item?.file_item?.file_name);
    return fileName ? `[文件] ${fileName}` : "[文件]";
  }

  if (type === MESSAGE_ITEM_TYPE_IMAGE) {
    const url = normalizedDisplayUrl(item?.image_item?.url);
    return url ? `[图片] ${url}` : "[图片]";
  }

  if (type === MESSAGE_ITEM_TYPE_VIDEO) {
    return "[视频]";
  }

  return null;
}

function normalizeRefMessage(ref) {
  if (!ref || typeof ref !== "object") {
    return null;
  }

  const title = trimmedString(ref?.title) || null;
  const itemType = Number(ref?.message_item?.type ?? 0) || null;
  const body = buildRefBodyFromItem(ref?.message_item) || null;
  if (!title && !body && !itemType) {
    return null;
  }

  return {
    title,
    itemType,
    body,
  };
}

function formatRefSummary(ref) {
  if (!ref) {
    return "";
  }

  const parts = [];
  if (ref.title) {
    parts.push(ref.title);
  }
  if (ref.body && ref.body !== ref.title) {
    parts.push(ref.body);
  }

  return parts.join(" | ").trim();
}

function renderTextWithReference(item) {
  const text = trimmedString(item?.text);
  const refSummary = formatRefSummary(item?.refMessage);
  if (refSummary && text) {
    return `[引用: ${refSummary}]\n${text}`;
  }
  if (refSummary) {
    return `[引用: ${refSummary}]`;
  }
  return text;
}

function normalizeInboundItem(item, index) {
  const type = Number(item?.type ?? 0);
  const refMessage = normalizeRefMessage(item?.ref_msg);
  if (type === MESSAGE_ITEM_TYPE_TEXT) {
    const text = trimmedString(item?.text_item?.text);
    if (!text && !refMessage) {
      return null;
    }
    return {
      index,
      type: "text",
      text,
      refMessage,
    };
  }

  if (type === MESSAGE_ITEM_TYPE_IMAGE) {
    const image = item?.image_item ?? {};
    const media = image.media ?? {};
    return {
      index,
      type: "image",
      label: "[图片]",
      url: normalizedDisplayUrl(image.url),
      encryptQueryParam: trimmedString(media.encrypt_query_param) || null,
      hasAesKey: Boolean(trimmedString(image.aeskey) || trimmedString(media.aes_key)),
      size: normalizePositiveNumber(image.mid_size ?? image.hd_size),
      width: normalizePositiveNumber(image.thumb_width),
      height: normalizePositiveNumber(image.thumb_height),
      refMessage,
    };
  }

  if (type === MESSAGE_ITEM_TYPE_VOICE) {
    const voice = item?.voice_item ?? {};
    const media = voice.media ?? {};
    return {
      index,
      type: "voice",
      label: "[语音]",
      text: trimmedString(voice.text) || null,
      encryptQueryParam: trimmedString(media.encrypt_query_param) || null,
      hasAesKey: Boolean(trimmedString(media.aes_key)),
      playtime: normalizePositiveNumber(voice.playtime),
      sampleRate: normalizePositiveNumber(voice.sample_rate),
      bitsPerSample: normalizePositiveNumber(voice.bits_per_sample),
      encodeType: normalizePositiveNumber(voice.encode_type),
      refMessage,
    };
  }

  if (type === MESSAGE_ITEM_TYPE_FILE) {
    const file = item?.file_item ?? {};
    const media = file.media ?? {};
    return {
      index,
      type: "file",
      label: "[文件]",
      fileName: trimmedString(file.file_name) || null,
      encryptQueryParam: trimmedString(media.encrypt_query_param) || null,
      hasAesKey: Boolean(trimmedString(media.aes_key)),
      size: normalizePositiveNumber(file.len),
      md5: trimmedString(file.md5) || null,
      refMessage,
    };
  }

  if (type === MESSAGE_ITEM_TYPE_VIDEO) {
    const video = item?.video_item ?? {};
    const media = video.media ?? {};
    return {
      index,
      type: "video",
      label: "[视频]",
      encryptQueryParam: trimmedString(media.encrypt_query_param) || null,
      hasAesKey: Boolean(trimmedString(media.aes_key)),
      size: normalizePositiveNumber(video.video_size),
      playLength: normalizePositiveNumber(video.play_length),
      width: normalizePositiveNumber(video.thumb_width),
      height: normalizePositiveNumber(video.thumb_height),
      md5: trimmedString(video.video_md5) || null,
      refMessage,
    };
  }

  const media = pickMediaObject(item);
  return {
    index,
    type: "unknown",
    label: `[消息类型 ${type || "?"}]`,
    encryptQueryParam: trimmedString(media?.encrypt_query_param) || null,
    hasAesKey: Boolean(trimmedString(media?.aes_key)),
    refMessage,
  };
}

function renderInboundItem(item) {
  if (!item) {
    return "";
  }
  if (item.type === "text") {
    return renderTextWithReference(item);
  }
  if (item.type === "voice" && item.text) {
    return item.text;
  }
  if (item.type === "file" && item.fileName) {
    return `[文件] ${item.fileName}`;
  }
  if (item.type === "image" && item.url) {
    return `[图片] ${item.url}`;
  }
  return item.label ?? "";
}

export function extractInboundItems(message) {
  if (!Array.isArray(message?.item_list)) {
    return [];
  }
  return message.item_list
    .map((item, index) => normalizeInboundItem(item, index))
    .filter(Boolean);
}

export function extractInboundText(message) {
  return extractInboundItems(message)
    .map((item) => renderInboundItem(item))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractWechatConversationMeta(message) {
  const senderUserId = trimmedString(message?.from_user_id) || null;
  const groupId = trimmedString(message?.group_id) || null;
  const sessionId = trimmedString(message?.session_id) || null;
  const chatType = groupId ? "group" : "direct";

  return {
    chatType,
    conversationId: groupId || senderUserId || sessionId || null,
    senderUserId,
    groupId,
    sessionId,
  };
}

export function shouldProcessInboundMessage(message) {
  if (!message || Number(message.message_type ?? MESSAGE_TYPE_USER) === MESSAGE_TYPE_BOT) {
    return false;
  }
  const meta = extractWechatConversationMeta(message);
  if (!meta.senderUserId) {
    return false;
  }
  return extractInboundItems(message).length > 0;
}
