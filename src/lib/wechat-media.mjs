import crypto, { createCipheriv } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfigCdnBaseUrl } from "./accounts.mjs";
import { getUploadUrl } from "./wechat-api.mjs";

export const DEFAULT_WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

const WECHAT_MEDIA_OUTBOUND_TEMP_DIR = path.join(os.tmpdir(), "weixin-agent", "media", "outbound");

const EXTENSION_TO_MIME = Object.freeze({
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
});

const MIME_TO_EXTENSION = Object.freeze({
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "text/plain": ".txt",
  "text/csv": ".csv",
});

const UPLOAD_MEDIA_TYPE = Object.freeze({
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
});

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value ?? "").trim());
}

function isFileUrl(value) {
  return /^file:\/\//i.test(String(value ?? "").trim());
}

function getMimeFromFilename(filename) {
  const ext = path.extname(String(filename ?? "")).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

function getExtensionFromMime(mimeType) {
  const normalized = String(mimeType ?? "").split(";")[0].trim().toLowerCase();
  return MIME_TO_EXTENSION[normalized] ?? ".bin";
}

function getExtensionFromContentTypeOrUrl(contentType, url) {
  if (contentType) {
    const ext = getExtensionFromMime(contentType);
    if (ext !== ".bin") {
      return ext;
    }
  }

  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (EXTENSION_TO_MIME[ext]) {
      return ext;
    }
  } catch {
    // fall through
  }

  return ".bin";
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function tempFileName(prefix, extension) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}${extension}`;
}

function resolveLocalPath(mediaInput) {
  const raw = String(mediaInput ?? "").trim();
  if (isFileUrl(raw)) {
    return new URL(raw).pathname;
  }
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return path.resolve(raw);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((Number(plaintextSize) + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function buildCdnUploadUrl({
  cdnBaseUrl,
  uploadParam,
  filekey,
}) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadBufferToCdn({
  buf,
  uploadParam,
  filekey,
  cdnBaseUrl,
  aeskey,
}) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const response = await fetch(buildCdnUploadUrl({
    cdnBaseUrl,
    uploadParam,
    filekey,
  }), {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(ciphertext),
  });

  if (response.status >= 400) {
    const errorMessage = response.headers.get("x-error-message") ?? (await response.text());
    throw new Error(`CDN upload failed: ${response.status} ${response.statusText} ${errorMessage}`);
  }

  const downloadParam = response.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN upload response is missing x-encrypted-param.");
  }

  return {
    downloadEncryptedQueryParam: downloadParam,
    ciphertextSize: ciphertext.length,
  };
}

async function downloadRemoteMediaToTemp(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Remote media download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = getExtensionFromContentTypeOrUrl(response.headers.get("content-type"), url);
  await fs.mkdir(WECHAT_MEDIA_OUTBOUND_TEMP_DIR, { recursive: true });

  const filePath = path.join(
    WECHAT_MEDIA_OUTBOUND_TEMP_DIR,
    tempFileName("weixin-remote", extension),
  );
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function resolveMediaInputToFile(mediaInput) {
  if (isRemoteUrl(mediaInput)) {
    const filePath = await downloadRemoteMediaToTemp(mediaInput);
    return {
      filePath,
      cleanup: async () => {
        try {
          await fs.unlink(filePath);
        } catch {
          // best effort
        }
      },
    };
  }

  return {
    filePath: resolveLocalPath(mediaInput),
    cleanup: async () => {},
  };
}

function detectMediaKind(filePath) {
  const mime = getMimeFromFilename(filePath);
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  return "file";
}

export async function uploadMediaInputToWechat({
  accountId,
  baseUrl,
  token,
  toUserId,
  mediaInput,
  cdnBaseUrl = null,
}) {
  const { filePath, cleanup } = await resolveMediaInputToFile(mediaInput);
  try {
    const resolvedCdnBaseUrl = cdnBaseUrl || loadConfigCdnBaseUrl(accountId) || DEFAULT_WECHAT_CDN_BASE_URL;
    const plaintext = await fs.readFile(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString("hex");
    const aeskey = crypto.randomBytes(16);
    const kind = detectMediaKind(filePath);

    const uploadUrlResponse = await getUploadUrl({
      accountId,
      baseUrl,
      token,
      filekey,
      mediaType: kind === "image"
        ? UPLOAD_MEDIA_TYPE.IMAGE
        : (kind === "video" ? UPLOAD_MEDIA_TYPE.VIDEO : UPLOAD_MEDIA_TYPE.FILE),
      toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      noNeedThumb: true,
      aesKeyHex: aeskey.toString("hex"),
    });

    if (!uploadUrlResponse?.upload_param) {
      throw new Error("getuploadurl did not return upload_param.");
    }

    const uploaded = await uploadBufferToCdn({
      buf: plaintext,
      uploadParam: uploadUrlResponse.upload_param,
      filekey,
      cdnBaseUrl: resolvedCdnBaseUrl,
      aeskey,
    });

    return {
      kind,
      filePath,
      fileName: path.basename(filePath),
      fileSize: rawsize,
      fileSizeCiphertext: uploaded.ciphertextSize,
      filekey,
      downloadEncryptedQueryParam: uploaded.downloadEncryptedQueryParam,
      aesKeyHex: aeskey.toString("hex"),
    };
  } finally {
    await cleanup();
  }
}

function encodeAesKeyHexForMedia(aesKeyHex) {
  return Buffer.from(String(aesKeyHex ?? ""), "utf8").toString("base64");
}

export function buildWechatMediaItem(uploadedMedia) {
  const mediaRef = {
    encrypt_query_param: uploadedMedia.downloadEncryptedQueryParam,
    aes_key: encodeAesKeyHexForMedia(uploadedMedia.aesKeyHex),
    encrypt_type: 1,
  };

  if (uploadedMedia.kind === "image") {
    return {
      type: 2,
      image_item: {
        media: mediaRef,
        mid_size: uploadedMedia.fileSizeCiphertext,
      },
    };
  }

  if (uploadedMedia.kind === "video") {
    return {
      type: 5,
      video_item: {
        media: mediaRef,
        video_size: uploadedMedia.fileSizeCiphertext,
      },
    };
  }

  return {
    type: 4,
    file_item: {
      media: mediaRef,
      file_name: uploadedMedia.fileName,
      len: String(uploadedMedia.fileSize),
    },
  };
}
