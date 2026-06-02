import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCopyPrompt, normalizeCopyPackage } from "./xhs-rules.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
await loadLocalEnv(join(root, ".env.local"));

const port = Number(process.env.PORT || 4173);
const apiKey = process.env.BANANAROUTER_API_KEY;
const baseURL = process.env.BANANAROUTER_BASE_URL || "https://api.bananarouter.com";
const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const deepseekBaseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const image2TimeoutMs = Number(process.env.IMAGE2_TIMEOUT_MS || 90000);
const outputRoot = join(root, "outputs");
const appMode = process.env.APP_MODE === "web" ? "web" : "local";
const host = process.env.HOST || (appMode === "web" ? "0.0.0.0" : "127.0.0.1");
const accessPassword = String(process.env.ACCESS_PASSWORD || "").trim();
const accessSecret = String(process.env.ACCESS_SECRET || accessPassword || "xhs-note-studio-local").trim();
const accessCookieName = "xhs_access";
const accessMaxAgeSeconds = 60 * 60 * 24 * 30;

const contentTypes = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "application/javascript;charset=utf-8",
  ".mjs": "application/javascript;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png",
};

async function loadLocalEnv(filePath) {
  let envText = "";
  try {
    envText = await readFile(filePath, "utf8");
  } catch {
    return;
        }

  envText.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;
    const [, key, rawValue] = match;
    if (process.env[key]) return;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  });
}

function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json;charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function sendBuffer(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

async function readJSON(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) return cookies;
      const key = decodeURIComponent(part.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
      cookies[key] = value;
      return cookies;
    }, {});
}

function stableDigest(value) {
  return createHmac("sha256", "xhs-note-studio-access").update(String(value)).digest();
}

function safeCompare(left, right) {
  return timingSafeEqual(stableDigest(left), stableDigest(right));
}

function accessSignature(issuedAt) {
  return createHmac("sha256", accessSecret)
    .update(`xhs-access:${issuedAt}:${accessPassword}`)
    .digest("base64url");
}

function signAccessToken(issuedAt = Date.now()) {
  return `${issuedAt}.${accessSignature(issuedAt)}`;
}

function verifyAccessToken(token) {
  if (!accessPassword) return true;
  const [issuedAt, signature] = String(token || "").split(".");
  const issuedAtNumber = Number(issuedAt);
  if (!issuedAt || !signature || !Number.isFinite(issuedAtNumber)) return false;
  if (Date.now() - issuedAtNumber > accessMaxAgeSeconds * 1000) return false;
  return safeCompare(signature, accessSignature(issuedAt));
}

function accessCookieHeader(req, token, maxAge = accessMaxAgeSeconds) {
  const secure = appMode === "web" || req.headers["x-forwarded-proto"] === "https";
  return `${accessCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function isAccessAllowed(req) {
  if (!accessPassword) return true;
  return verifyAccessToken(parseCookies(req)[accessCookieName]);
}

function requireAccess(req, res) {
  if (isAccessAllowed(req)) return true;
  sendJSON(res, 401, {
    error: "请输入访问密码后再继续。",
    accessRequired: true,
  });
  return false;
}

async function handleAccessStatus(req, res) {
  sendJSON(res, 200, {
    required: Boolean(accessPassword),
    authorized: isAccessAllowed(req),
  });
}

async function handleAccessLogin(req, res) {
  if (!accessPassword) {
    sendJSON(res, 200, { ok: true, required: false, authorized: true });
    return;
  }

  const body = await readJSON(req);
  if (!safeCompare(body.password || "", accessPassword)) {
    sendJSON(res, 401, {
      error: "访问密码不正确。",
      accessRequired: true,
    });
    return;
  }

  sendJSON(
    res,
    200,
    { ok: true, required: true, authorized: true },
    { "Set-Cookie": accessCookieHeader(req, signAccessToken()) }
  );
}

async function handleAccessLogout(req, res) {
  sendJSON(
    res,
    200,
    { ok: true },
    { "Set-Cookie": accessCookieHeader(req, "", 0) }
  );
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  const normalized = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(root, normalized);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && rel !== "..";
}

function allowedStaticPath(filePath) {
  const publicFiles = new Set(["index.html", "app.js", "styles.css", "xhs-rules.mjs"]);
  const relativePath = relative(root, filePath);
  if (publicFiles.has(relativePath)) return true;
  if (relativePath.startsWith(".") || relativePath.split("/").some((part) => part.startsWith("."))) return false;
  if (relativePath.startsWith("outputs/") && isInside(outputRoot, filePath)) {
    return [".png", ".jpg", ".jpeg", ".webp"].includes(extname(filePath).toLowerCase());
  }
  return false;
}

function isOutputStaticPath(filePath) {
  const relativePath = relative(root, filePath);
  return relativePath.startsWith("outputs/") && isInside(outputRoot, filePath);
}

function isProtectedApiPath(pathname) {
  return (
    pathname.startsWith("/api/image2/") ||
    pathname.startsWith("/api/copy/") ||
    pathname.startsWith("/api/output/") ||
    pathname.startsWith("/api/export/")
  );
}

async function handleModels(_req, res) {
  if (!apiKey) {
    sendJSON(res, 500, { error: "BANANAROUTER_API_KEY is not configured." });
    return;
  }

  const upstream = await fetch(`${baseURL}/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  const payload = await upstream.json().catch(() => ({}));
  sendJSON(res, upstream.status, payload);
}

async function handleAppStatus(_req, res) {
  sendJSON(res, 200, {
    mode: appMode,
    canOpenFolder: appMode === "local",
    canDownloadImages: true,
  });
}

async function handleGenerate(req, res) {
  if (!apiKey) {
    sendJSON(res, 500, { error: "BANANAROUTER_API_KEY is not configured." });
    return;
  }

  const body = await readJSON(req);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    sendJSON(res, 400, { error: "prompt is required." });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), image2TimeoutMs);
  let upstream;
  try {
    upstream = await fetch(`${baseURL}/v1/images/generations`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: body.model || "gpt-image-2",
        prompt,
        n: Number(body.n || 1),
        size: body.size || "1024x1536",
        quality: body.quality || "auto",
        output_format: body.output_format || "png",
        moderation: body.moderation || "auto",
        response_format: body.response_format || "b64_json",
      }),
    });
  } catch (error) {
    if (error.name === "AbortError") {
      sendJSON(res, 504, { error: "Image2 请求超时，请稍后重试。" });
      return;
    }
    sendJSON(res, 502, {
      error: "Image2 上游连接失败，请稍后重试。",
      details: error.message || "upstream fetch failed",
    });
    return;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    sendJSON(res, upstream.status, {
      error: payload.error?.message || payload.error || "Image generation failed.",
      details: payload,
    });
    return;
  }

  sendJSON(res, 200, payload);
}

function imageDataToFile(imageUrl) {
  const match = String(imageUrl || "").match(/^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/);
  if (!match) {
    throw new Error("图片数据格式不正确，无法保存。");
  }
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  return {
    ext,
    buffer: Buffer.from(match[2], "base64"),
  };
}

async function imageUrlToFile(imageUrl) {
  const value = String(imageUrl || "");
  if (value.startsWith("data:image/")) return imageDataToFile(value);
  if (!/^https?:\/\//.test(value)) throw new Error("图片地址格式不正确，无法保存。");

  const response = await fetch(value);
  if (!response.ok) throw new Error("图片下载失败，无法保存到本地。");
  const contentType = response.headers.get("content-type") || "image/png";
  const extMatch = contentType.match(/image\/(png|jpeg|jpg|webp)/);
  const ext = extMatch?.[1] === "jpeg" ? "jpg" : extMatch?.[1] || "png";
  return {
    ext,
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

function exportFolderName() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "");
}

function outputSessionId(title = "") {
  const stamp = exportFolderName();
  const cleanedTitle = String(title)
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleanedTitle ? `${stamp}-${cleanedTitle}` : stamp;
}

function assertSessionId(sessionId) {
  const value = String(sessionId || "").trim();
  if (!/^[\p{Letter}\p{Number}][\p{Letter}\p{Number}._-]{0,120}$/u.test(value)) {
    throw new Error("输出文件夹 ID 不正确。");
  }
  return value;
}

function outputSessionDir(sessionId) {
  return join(outputRoot, assertSessionId(sessionId));
}

function outputWebPath(sessionId, filename) {
  return `/outputs/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}`;
}

async function readOutputManifest(sessionId) {
  try {
    const text = await readFile(join(outputSessionDir(sessionId), "manifest.json"), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeOutputManifest(sessionId, manifest) {
  const dir = outputSessionDir(sessionId);
  await mkdir(dir, { recursive: true });
  const nextManifest = {
    ...manifest,
    sessionId,
    folderPath: dir,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(nextManifest, null, 2), "utf8");
  return nextManifest;
}

function publishMarkdown({ copy, style, pages = [], savedPages = {} }) {
  if (!copy) return "";
  const imageLines = pages.length
    ? pages
        .map((page, index) => {
          const pageNumber = index + 1;
          const filename = `page-${String(pageNumber).padStart(2, "0")}.png`;
          const saved = savedPages[String(pageNumber)] || savedPages[pageNumber];
          return `- ${saved?.filename || filename} ${saved ? "已保存" : "待生成"}：${page.title || ""}`;
        })
        .join("\n")
    : "- 等待生成图片";

  return `# ${copy.title || ""}

${copy.opening || ""}

${copy.body || ""}

## 图片
${imageLines}

## 话题
${(copy.hashtags || []).map((tag) => `#${String(tag).replace(/^#/, "")}`).join(" ")}

## 备注
- 风格：${style || ""}
- 图片尺寸：3:4
- 文案生成：${copy.copyProvider || "DeepSeek"}
- 生成方式：${copy.imageProvider || "Image2"}
`;
}

async function handleOutputSession(req, res) {
  const body = await readJSON(req);
  const sessionId = body.sessionId ? assertSessionId(body.sessionId) : outputSessionId(body.title);
  const dir = outputSessionDir(sessionId);
  const existing = (await readOutputManifest(sessionId)) || {};
  const savedPages = existing.savedPages || {};
  const manifest = await writeOutputManifest(sessionId, {
    ...existing,
    createdAt: existing.createdAt || new Date().toISOString(),
    title: body.title || existing.title || "",
    style: body.style || existing.style || "",
    copy: body.copy || existing.copy || null,
    pages: Array.isArray(body.pages) ? body.pages : existing.pages || [],
    savedPages,
  });

  const publishText = body.publishText || publishMarkdown(manifest);
  if (publishText) await writeFile(join(dir, "发布文案.md"), publishText, "utf8");

  sendJSON(res, 200, {
    sessionId,
    folderPath: dir,
    manifest,
  });
}

async function handleGetOutputSession(req, res, url) {
  const sessionId = assertSessionId(url.searchParams.get("sessionId"));
  const manifest = await readOutputManifest(sessionId);
  if (!manifest) {
    sendJSON(res, 404, { error: "还没有找到这个输出文件夹。" });
    return;
  }
  sendJSON(res, 200, {
    sessionId,
    folderPath: outputSessionDir(sessionId),
    manifest,
  });
}

async function handleSaveOutputPage(req, res) {
  const body = await readJSON(req);
  const sessionId = assertSessionId(body.sessionId);
  const pageIndex = Number(body.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 18) {
    sendJSON(res, 400, { error: "pageIndex 必须是 1-18。" });
    return;
  }

  const manifest = (await readOutputManifest(sessionId)) || {
    sessionId,
    createdAt: new Date().toISOString(),
    savedPages: {},
  };
  const { ext, buffer } = await imageUrlToFile(body.imageUrl);
  const filename = `page-${String(pageIndex).padStart(2, "0")}.${ext}`;
  const dir = outputSessionDir(sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), buffer);

  const savedPage = {
    pageIndex,
    filename,
    title: body.title || "",
    savedAt: new Date().toISOString(),
    webPath: outputWebPath(sessionId, filename),
    prompt: body.prompt || "",
    mode: body.mode || "full",
    style: body.style || manifest.style || "",
  };

  const savedPages = {
    ...(manifest.savedPages || {}),
    [String(pageIndex)]: savedPage,
  };
  const nextManifest = await writeOutputManifest(sessionId, {
    ...manifest,
    savedPages,
    imageCount: Object.keys(savedPages).length,
  });

  const publishText = body.publishText || publishMarkdown(nextManifest);
  if (publishText) await writeFile(join(dir, "发布文案.md"), publishText, "utf8");

  sendJSON(res, 200, {
    sessionId,
    folderPath: dir,
    savedPage,
    manifest: nextManifest,
  });
}

async function handleOpenOutput(req, res) {
  const body = await readJSON(req);
  const dir = body.sessionId ? outputSessionDir(body.sessionId) : outputRoot;
  await mkdir(dir, { recursive: true });
  if (appMode === "web") {
    sendJSON(res, 400, { error: "网页部署模式不能打开本地文件夹，请下载图片包。" });
    return;
  }
  execFile("/usr/bin/open", [dir], () => {});
  sendJSON(res, 200, { folderPath: dir });
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, dosDate };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, dosDate } = zipDateTime();

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const content = file.content;
    const crc = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + content.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function handleDownloadOutput(req, res, url) {
  const body =
    req.method === "GET"
      ? { sessionId: url.searchParams.get("sessionId") }
      : await readJSON(req);
  const sessionId = assertSessionId(body.sessionId);
  const dir = outputSessionDir(sessionId);
  const manifest = await readOutputManifest(sessionId);
  if (!manifest) {
    sendJSON(res, 404, { error: "还没有找到这个图片包。" });
    return;
  }

  const savedPages = Object.values(manifest.savedPages || {}).sort((a, b) => a.pageIndex - b.pageIndex);
  if (!savedPages.length) {
    sendJSON(res, 400, { error: "还没有可下载的图片，请先生成图片。" });
    return;
  }

  const files = [];
  for (const page of savedPages) {
    files.push({
      name: page.filename,
      content: await readFile(join(dir, page.filename)),
    });
  }
  files.push({
    name: "发布文案.md",
    content: await readFile(join(dir, "发布文案.md")).catch(() => Buffer.from(publishMarkdown(manifest), "utf8")),
  });
  files.push({
    name: "manifest.json",
    content: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
  });

  const zip = createZip(files);
  const filename = encodeURIComponent(`${manifest.title || "小红书图文"}-${sessionId}.zip`);
  sendBuffer(res, 200, zip, {
    "Content-Type": "application/zip",
    "Content-Length": String(zip.length),
    "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
  });
}

async function handleExportImages(req, res) {
  const body = await readJSON(req);
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) {
    sendJSON(res, 400, { error: "没有可导出的图片，请先生成完整图文。" });
    return;
  }

  const exportDir = join(root, "exports", exportFolderName());
  await mkdir(exportDir, { recursive: true });

  const files = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const { ext, buffer } = imageDataToFile(image.imageUrl);
    const filename = `page-${String(index + 1).padStart(2, "0")}.${ext}`;
    await writeFile(join(exportDir, filename), buffer);
    files.push(filename);
  }

  if (body.publishText) {
    await writeFile(join(exportDir, "发布文案.md"), String(body.publishText), "utf8");
    files.push("发布文案.md");
  }

  await writeFile(
    join(exportDir, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        title: body.title || "",
        imageCount: images.length,
        files,
      },
      null,
      2
    ),
    "utf8"
  );
  files.push("manifest.json");

  if (appMode === "local") execFile("/usr/bin/open", [exportDir], () => {});
  sendJSON(res, 200, {
    folderPath: exportDir,
    imageCount: images.length,
    files,
  });
}

function extractJSON(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("DeepSeek 没有返回文案内容");
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek 返回内容不是 JSON");
    return JSON.parse(match[0]);
  }
}

async function handleCopyStatus(_req, res) {
  sendJSON(res, 200, {
    configured: Boolean(deepseekApiKey),
    model: deepseekModel,
  });
}

async function handleCopyGenerate(req, res) {
  if (!deepseekApiKey) {
    sendJSON(res, 500, { error: "DEEPSEEK_API_KEY is not configured." });
    return;
  }

  const body = await readJSON(req);
  const topic = String(body.topic || "").trim();
  const material = String(body.material || "").trim();
  const persona = String(body.persona || "").trim();
  const style = String(body.style || "").trim();

  if (!topic) {
    sendJSON(res, 400, { error: "topic is required." });
    return;
  }

  const upstream = await fetch(`${deepseekBaseURL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: deepseekModel,
      messages: [
        {
          role: "system",
          content: "你只输出可解析 JSON。你擅长把语料整理成小红书图文发布包和拆页方案。",
        },
        {
          role: "user",
          content: buildCopyPrompt({ topic, material, persona, style }),
        },
      ],
      temperature: 0.7,
      response_format: { type: "json_object" },
    }),
  });

  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    sendJSON(res, upstream.status, {
      error: payload.error?.message || payload.error || "DeepSeek copy generation failed.",
      details: payload,
    });
    return;
  }

  try {
    const content = payload.choices?.[0]?.message?.content;
    const copyPackage = normalizeCopyPackage(extractJSON(content));
    sendJSON(res, 200, copyPackage);
  } catch (error) {
    sendJSON(res, 502, {
      error: error.message || "DeepSeek 返回格式无法解析",
      details: payload,
    });
  }
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = safeStaticPath(url.pathname);
  if (!allowedStaticPath(filePath)) {
    sendJSON(res, 404, { error: "Not found." });
    return;
  }
  if (isOutputStaticPath(filePath) && !requireAccess(req, res)) return;
  try {
    const data = await readFile(filePath);
    const type = contentTypes[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    sendJSON(res, 404, { error: "Not found." });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/access/status") {
      await handleAccessStatus(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/access/login") {
      await handleAccessLogin(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/access/logout") {
      await handleAccessLogout(req, res);
      return;
    }
    if (isProtectedApiPath(url.pathname) && !requireAccess(req, res)) return;
    if (req.method === "GET" && url.pathname === "/api/app/status") {
      await handleAppStatus(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/image2/models") {
      await handleModels(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/image2/generate") {
      await handleGenerate(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/copy/status") {
      await handleCopyStatus(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/copy/generate") {
      await handleCopyGenerate(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/output/session") {
      await handleOutputSession(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/output/session") {
      await handleGetOutputSession(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/output/page") {
      await handleSaveOutputPage(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/output/open") {
      await handleOpenOutput(req, res);
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/output/download") {
      await handleDownloadOutput(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/export/images") {
      await handleExportImages(req, res);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await handleStatic(req, res);
      return;
    }
    sendJSON(res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJSON(res, 500, { error: error.message || "Internal server error." });
  }
});

server.listen(port, host, () => {
  console.log(`小红书图文生产台已启动：http://${host}:${port}/`);
  console.log(accessPassword ? "Access gate: enabled" : "Access gate: disabled");
  console.log(apiKey ? "Image2 proxy: configured" : "Image2 proxy: missing BANANAROUTER_API_KEY");
  console.log(deepseekApiKey ? `DeepSeek copy: configured (${deepseekModel})` : "DeepSeek copy: missing DEEPSEEK_API_KEY");
});
