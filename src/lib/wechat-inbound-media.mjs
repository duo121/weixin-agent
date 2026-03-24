import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { loadConfigCdnBaseUrl } from "./accounts.mjs";
import { resolveAgentInboundMediaDir } from "./paths.mjs";
import { DEFAULT_WECHAT_CDN_BASE_URL } from "./wechat-media.mjs";

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
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

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${ensureTrailingSlash(cdnBaseUrl).replace(/\/$/, "")}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 ?? ""), "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Unsupported aes_key encoding: decoded=${decoded.length} bytes`);
}

function normalizePositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    if (offset + 4 > buffer.length) {
      break;
    }

    const blockLength = buffer.readUInt16BE(offset + 2);
    if (blockLength < 2 || offset + 2 + blockLength > buffer.length) {
      break;
    }

    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && offset + 9 <= buffer.length) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
      };
    }

    offset += 2 + blockLength;
  }

  return null;
}

function imageDimensionsFromBuffer(buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer.length >= 10) {
    const signature = buffer.slice(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
      };
    }
  }

  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }

  if (buffer.length >= 30 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
    const chunkType = buffer.slice(12, 16).toString("ascii");
    if (chunkType === "VP8X") {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height };
    }
  }

  return jpegDimensions(buffer);
}

function imageExtensionFromBuffer(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: ".png", mediaType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: ".jpg", mediaType: "image/jpeg" };
  }
  if (buffer.length >= 6) {
    const signature = buffer.slice(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { ext: ".gif", mediaType: "image/gif" };
    }
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
    return { ext: ".webp", mediaType: "image/webp" };
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { ext: ".bmp", mediaType: "image/bmp" };
  }
  return { ext: ".bin", mediaType: "application/octet-stream" };
}

function mediaGuessFromBuffer(buffer, fallbackType = "application/octet-stream") {
  if (fallbackType.startsWith("image/")) {
    return imageExtensionFromBuffer(buffer);
  }
  if (buffer.length >= 5 && buffer.slice(0, 5).toString("ascii") === "%PDF-") {
    return { ext: ".pdf", mediaType: "application/pdf" };
  }
  if (buffer.length >= 8 && buffer.slice(4, 8).toString("ascii") === "ftyp") {
    return { ext: ".mp4", mediaType: "video/mp4" };
  }
  return { ext: ".bin", mediaType: fallbackType || "application/octet-stream" };
}

function extnameFromUrl(rawUrl) {
  try {
    const ext = path.extname(new URL(rawUrl).pathname).toLowerCase();
    return ext || "";
  } catch {
    return "";
  }
}

function sanitizeBasename(value, fallback) {
  const cleaned = String(value ?? "").replace(/[^\w.\-()\u4e00-\u9fa5]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`CDN download failed: ${response.status} ${response.statusText} ${body}`.trim());
  }
  return Buffer.from(await response.arrayBuffer());
}

async function saveInboundBuffer({
  accountId,
  messageId,
  index,
  suggestedName,
  extension,
  buffer,
}) {
  const accountDir = path.join(resolveAgentInboundMediaDir(), encodeURIComponent(String(accountId ?? "").trim() || "unknown"));
  const dateDir = new Date().toISOString().slice(0, 10);
  const messageDir = sanitizeBasename(`msg-${String(messageId ?? "unknown")}`, `msg-unknown-${index + 1}`);
  const targetDir = path.join(accountDir, dateDir, messageDir);
  await fs.mkdir(targetDir, { recursive: true });

  const baseName = sanitizeBasename(suggestedName, `msg-${String(messageId ?? "unknown")}-item-${index + 1}`);
  const ext = extension || path.extname(baseName) || ".bin";
  const fileName = baseName.endsWith(ext) ? baseName : `${baseName}${ext}`;
  const filePath = path.join(targetDir, fileName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function materializeImageItem({
  accountId,
  cdnBaseUrl,
  messageId,
  item,
  index,
}) {
  const image = item?.image_item ?? {};
  const media = image.media ?? {};
  const encryptQueryParam = trimmedString(media.encrypt_query_param);
  if (!encryptQueryParam) {
    return {
      index,
      type: "image",
      label: "[图片]",
      downloadError: "missing encrypt_query_param",
    };
  }

  const aesKeyBase64 = image.aeskey
    ? Buffer.from(String(image.aeskey), "hex").toString("base64")
    : trimmedString(media.aes_key);

  const encrypted = await fetchBuffer(buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl));
  const buffer = aesKeyBase64 ? decryptAesEcb(encrypted, parseAesKey(aesKeyBase64)) : encrypted;
  const hintedExt = extnameFromUrl(image.url);
  const guessed = imageExtensionFromBuffer(buffer);
  const dimensions = imageDimensionsFromBuffer(buffer);
  const filePath = await saveInboundBuffer({
    accountId,
    messageId,
    index,
    suggestedName: `image-${index + 1}${hintedExt || guessed.ext}`,
    extension: hintedExt || guessed.ext,
    buffer,
  });

  return {
    index,
    type: "image",
    label: "[图片]",
    fileName: path.basename(filePath),
    url: normalizedDisplayUrl(image.url),
    localPath: filePath,
    mediaType: guessed.mediaType,
    size: buffer.length,
    sha256: sha256Hex(buffer),
    width: normalizePositiveNumber(dimensions?.width) ?? normalizePositiveNumber(image.thumb_width),
    height: normalizePositiveNumber(dimensions?.height) ?? normalizePositiveNumber(image.thumb_height),
  };
}

async function materializeFileItem({
  accountId,
  cdnBaseUrl,
  messageId,
  item,
  index,
}) {
  const fileItem = item?.file_item ?? {};
  const media = fileItem.media ?? {};
  const encryptQueryParam = trimmedString(media.encrypt_query_param);
  const aesKeyBase64 = trimmedString(media.aes_key);
  if (!encryptQueryParam || !aesKeyBase64) {
    return {
      index,
      type: "file",
      label: "[文件]",
      fileName: trimmedString(fileItem.file_name) || null,
      downloadError: "missing encrypted media fields",
    };
  }

  const encrypted = await fetchBuffer(buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl));
  const buffer = decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
  const fallbackType = "application/octet-stream";
  const guessed = mediaGuessFromBuffer(buffer, fallbackType);
  const fileName = trimmedString(fileItem.file_name) || `file-${index + 1}${guessed.ext}`;
  const filePath = await saveInboundBuffer({
    accountId,
    messageId,
    index,
    suggestedName: fileName,
    extension: path.extname(fileName) || guessed.ext,
    buffer,
  });

  return {
    index,
    type: "file",
    label: "[文件]",
    fileName,
    localPath: filePath,
    mediaType: guessed.mediaType,
    size: buffer.length,
    sha256: sha256Hex(buffer),
    md5: trimmedString(fileItem.md5) || null,
  };
}

async function materializeVideoItem({
  accountId,
  cdnBaseUrl,
  messageId,
  item,
  index,
}) {
  const videoItem = item?.video_item ?? {};
  const media = videoItem.media ?? {};
  const encryptQueryParam = trimmedString(media.encrypt_query_param);
  const aesKeyBase64 = trimmedString(media.aes_key);
  if (!encryptQueryParam || !aesKeyBase64) {
    return {
      index,
      type: "video",
      label: "[视频]",
      downloadError: "missing encrypted media fields",
    };
  }

  const encrypted = await fetchBuffer(buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl));
  const buffer = decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
  const guessed = mediaGuessFromBuffer(buffer, "video/mp4");
  const filePath = await saveInboundBuffer({
    accountId,
    messageId,
    index,
    suggestedName: `video-${index + 1}${guessed.ext}`,
    extension: guessed.ext,
    buffer,
  });

  return {
    index,
    type: "video",
    label: "[视频]",
    fileName: path.basename(filePath),
    localPath: filePath,
    mediaType: guessed.mediaType,
    size: buffer.length,
    sha256: sha256Hex(buffer),
    playLength: Number(videoItem.play_length ?? 0) || null,
    width: normalizePositiveNumber(videoItem.thumb_width),
    height: normalizePositiveNumber(videoItem.thumb_height),
    md5: trimmedString(videoItem.video_md5) || null,
  };
}

async function materializeVoiceItem({
  accountId,
  cdnBaseUrl,
  messageId,
  item,
  index,
}) {
  const voiceItem = item?.voice_item ?? {};
  const media = voiceItem.media ?? {};
  const encryptQueryParam = trimmedString(media.encrypt_query_param);
  const aesKeyBase64 = trimmedString(media.aes_key);
  if (!encryptQueryParam || !aesKeyBase64) {
    return {
      index,
      type: "voice",
      label: "[语音]",
      text: trimmedString(voiceItem.text) || null,
      downloadError: "missing encrypted media fields",
    };
  }

  const encrypted = await fetchBuffer(buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl));
  const buffer = decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
  const filePath = await saveInboundBuffer({
    accountId,
    messageId,
    index,
    suggestedName: `voice-${index + 1}.silk`,
    extension: ".silk",
    buffer,
  });

  return {
    index,
    type: "voice",
    label: "[语音]",
    text: trimmedString(voiceItem.text) || null,
    fileName: path.basename(filePath),
    localPath: filePath,
    mediaType: "audio/silk",
    size: buffer.length,
    sha256: sha256Hex(buffer),
    playtime: Number(voiceItem.playtime ?? 0) || null,
    sampleRate: normalizePositiveNumber(voiceItem.sample_rate),
    bitsPerSample: normalizePositiveNumber(voiceItem.bits_per_sample),
    encodeType: normalizePositiveNumber(voiceItem.encode_type),
  };
}

export async function materializeInboundWechatItems({
  accountId,
  message,
}) {
  if (!Array.isArray(message?.item_list) || message.item_list.length === 0) {
    return [];
  }

  const cdnBaseUrl = loadConfigCdnBaseUrl(accountId) || DEFAULT_WECHAT_CDN_BASE_URL;
  const messageId = message?.message_id ?? Date.now();

  const results = [];
  for (let index = 0; index < message.item_list.length; index += 1) {
    const item = message.item_list[index];
    const type = Number(item?.type ?? 0);

    try {
      if (type === 2) {
        results.push(await materializeImageItem({ accountId, cdnBaseUrl, messageId, item, index }));
        continue;
      }
      if (type === 4) {
        results.push(await materializeFileItem({ accountId, cdnBaseUrl, messageId, item, index }));
        continue;
      }
      if (type === 5) {
        results.push(await materializeVideoItem({ accountId, cdnBaseUrl, messageId, item, index }));
        continue;
      }
      if (type === 3) {
        results.push(await materializeVoiceItem({ accountId, cdnBaseUrl, messageId, item, index }));
      }
    } catch (error) {
      results.push({
        index,
        type: type === 2 ? "image" : (type === 3 ? "voice" : (type === 4 ? "file" : (type === 5 ? "video" : "unknown"))),
        label: type === 2 ? "[图片]" : (type === 3 ? "[语音]" : (type === 4 ? "[文件]" : (type === 5 ? "[视频]" : `[消息类型 ${type || "?"}]`))),
        downloadError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
