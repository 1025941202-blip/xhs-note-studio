import { buildImagePrompt, buildVisualContract, getSampleStyleOptions } from "./xhs-rules.mjs";

const $ = (selector) => document.querySelector(selector);

const els = {
  appShell: $("#appShell"),
  accessGate: $("#accessGate"),
  accessForm: $("#accessForm"),
  accessPassword: $("#accessPassword"),
  accessError: $("#accessError"),
  topic: $("#topic"),
  material: $("#material"),
  persona: $("#persona"),
  style: $("#style"),
  primaryFlow: $("#primaryFlow"),
  exportPackage: $("#exportPackage"),
  copyOutput: $("#copyOutput"),
  pageList: $("#pageList"),
  pageCount: $("#pageCount"),
  sampleGrid: $("#sampleGrid"),
  styleNote: $("#styleNote"),
  preview: $("#carouselPreview"),
  previewStatus: $("#previewStatus"),
  thumbStrip: $("#thumbStrip"),
  publishBox: $("#publishBox"),
  steps: $("#steps"),
  panels: [...document.querySelectorAll("[data-panel]")],
  nextTitle: $("#nextTitle"),
  nextText: $("#nextText"),
};

const state = {
  phase: "idle",
  view: "script",
  maxStep: "script",
  providerStatus: "checking",
  copyProviderStatus: "checking",
  appMode: "local",
  canOpenFolder: true,
  copy: null,
  pages: [],
  samples: [],
  images: [],
  previewItems: [],
  selectedIndex: 0,
  selectedStyle: "",
  styleNote: "",
  imageJobs: {},
  outputSession: null,
  savedPages: {},
  accessRequired: false,
  accessAuthorized: true,
};

const imageCacheConfig = {
  dbName: "xhs-note-studio-image-cache",
  storeName: "pages",
};

function imageCacheKey(sessionId, pageIndex) {
  return `${sessionId}:${pageIndex}`;
}

function openImageCache() {
  if (!("indexedDB" in window)) return Promise.resolve(null);

  return new Promise((resolve) => {
    const request = indexedDB.open(imageCacheConfig.dbName, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(imageCacheConfig.storeName, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function cachePageImage(pageIndex, imageUrl) {
  if (!state.outputSession?.sessionId || !String(imageUrl || "").startsWith("data:image/")) return false;
  const db = await openImageCache();
  if (!db) return false;

  return new Promise((resolve) => {
    const tx = db.transaction(imageCacheConfig.storeName, "readwrite");
    tx.objectStore(imageCacheConfig.storeName).put({
      key: imageCacheKey(state.outputSession.sessionId, pageIndex),
      sessionId: state.outputSession.sessionId,
      pageIndex,
      imageUrl,
      updatedAt: new Date().toISOString(),
    });
    tx.oncomplete = () => {
      db.close();
      resolve(true);
    };
    tx.onerror = () => {
      db.close();
      resolve(false);
    };
  });
}

async function readCachedPageImage(pageIndex) {
  if (!state.outputSession?.sessionId) return null;
  const db = await openImageCache();
  if (!db) return null;

  return new Promise((resolve) => {
    const tx = db.transaction(imageCacheConfig.storeName, "readonly");
    const request = tx
      .objectStore(imageCacheConfig.storeName)
      .get(imageCacheKey(state.outputSession.sessionId, pageIndex));
    request.onsuccess = () => resolve(request.result?.imageUrl || null);
    request.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

const image2Provider = {
  name: "image2-gpt-image-2",
  async generate({
    pages,
    style,
    mode,
    pagePlan,
    startIndex = 0,
    progressTotal,
    promptTotalPages,
    visualContract,
    onProgress = () => {},
    onGenerated = async () => {},
  }) {
    const results = [];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const pageIndex = startIndex + index + 1;
      const prompt = buildImagePrompt(page, style, {
        mode,
        pageIndex,
        totalPages: promptTotalPages || progressTotal || startIndex + pages.length,
        pagePlan,
        visualContract,
        styleNote: state.styleNote,
      });
      onProgress({
        current: pageIndex,
        total: progressTotal || startIndex + pages.length,
        title: page.title,
      });
      const payload = await requestImageGeneration({
        model: "gpt-image-2",
        prompt,
        n: 1,
        size: "1024x1536",
        quality: "low",
        output_format: "png",
        moderation: "auto",
        response_format: "b64_json",
      }, imageJobKey({ mode, style, pageIndex, prompt }));

      const b64 = payload.data?.[0]?.b64_json;
      const imageUrl = b64 ? `data:image/png;base64,${b64}` : payload.data?.[0]?.url;
      if (!imageUrl) {
        throw new Error("Image2 没有返回图片数据");
      }

      const item = {
        id: `${mode}-${pageIndex}`,
        mode,
        style,
        page,
        imageUrl,
        html: renderImageArtwork(page, imageUrl),
        prompt,
      };
      results.push(item);
      await onGenerated(item, pageIndex);
    }
    return results;
  },
};

const copyProvider = {
  name: "deepseek-v4-flash",
  async generate({ topic, material, persona, style }) {
    const response = await fetch("/api/copy/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, material, persona, style }),
    });
    const { payload } = await readAPIResponse(response);
    if (!response.ok) {
      throw new Error(payload.error || "DeepSeek 文案生成失败");
    }
    return payload;
  },
};

function imageJobKey({ mode, style, pageIndex, prompt }) {
  return `${mode}:${style}:${pageIndex}:${hashText(prompt)}`;
}

function hashText(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

async function requestImageGeneration(body, jobKey = "") {
  const existingJobId = jobKey ? state.imageJobs[jobKey] : "";
  if (existingJobId) {
    try {
      const result = await pollImageJob(existingJobId);
      delete state.imageJobs[jobKey];
      persistDraft();
      return result;
    } catch (error) {
      if (error.code !== "JOB_MISSING" && error.code !== "JOB_ERROR") throw error;
      delete state.imageJobs[jobKey];
      persistDraft();
    }
  }

  let response;
  try {
    response = await fetch("/api/image2/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("图片生成任务提交失败，通常是手机网络临时断开。请稍后再点主按钮重试。");
  }

  const { payload } = await readAPIResponse(response);
  if (!response.ok) throw new Error(payload.error || "Image2 任务创建失败");
  if (!payload.jobId) throw new Error("Image2 没有返回任务编号，请稍后重试。");
  if (jobKey) {
    state.imageJobs[jobKey] = payload.jobId;
    persistDraft();
  }

  try {
    const result = await pollImageJob(payload.jobId);
    if (jobKey) {
      delete state.imageJobs[jobKey];
      persistDraft();
    }
    return result;
  } catch (error) {
    if (jobKey && (error.code === "JOB_MISSING" || error.code === "JOB_ERROR")) {
      delete state.imageJobs[jobKey];
      persistDraft();
    }
    throw error;
  }
}

async function pollImageJob(jobId) {
  const startedAt = Date.now();
  let networkFailures = 0;

  while (Date.now() - startedAt < 1000 * 60 * 5) {
    await wait(2600);
    let response;
    try {
      response = await fetch(`/api/image2/jobs/${encodeURIComponent(jobId)}`);
      networkFailures = 0;
    } catch {
      networkFailures += 1;
      if (networkFailures >= 5) {
        throw new Error("手机网络连续中断，图片任务还没拿到结果。请保持页面打开后重试。");
      }
      continue;
    }

    const { payload } = await readAPIResponse(response);
    if (!response.ok) {
      const error = new Error(payload.error || "Image2 任务查询失败");
      if (response.status === 404) error.code = "JOB_MISSING";
      throw error;
    }
    if (payload.status === "done") return payload.payload;
    if (payload.status === "error") {
      const error = new Error(payload.error || "Image2 生成失败");
      error.code = "JOB_ERROR";
      throw error;
    }
  }

  throw new Error("图片生成等待时间太长，请稍后点主按钮继续补生成。");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showAccessGate(message = "") {
  state.accessRequired = true;
  state.accessAuthorized = false;
  if (els.appShell) els.appShell.classList.add("access-locked");
  if (els.accessError) els.accessError.textContent = message;
  if (els.accessGate) {
    els.accessGate.hidden = false;
    window.setTimeout(() => els.accessPassword?.focus(), 50);
  }
}

function hideAccessGate() {
  state.accessAuthorized = true;
  if (els.appShell) els.appShell.classList.remove("access-locked");
  if (els.accessGate) els.accessGate.hidden = true;
  if (els.accessError) els.accessError.textContent = "";
}

async function readAPIResponse(response, options = {}) {
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.accessRequired && options.showGate !== false) {
    showAccessGate("访问状态已过期，请重新输入密码。");
  }
  return { response, payload };
}

async function checkAccessGate() {
  const response = await fetch("/api/access/status");
  const { payload } = await readAPIResponse(response, { showGate: false });
  state.accessRequired = Boolean(payload.required);
  state.accessAuthorized = !payload.required || Boolean(payload.authorized);
  if (state.accessRequired && !state.accessAuthorized) {
    showAccessGate();
    return false;
  }
  hideAccessGate();
  return true;
}

async function handleAccessLogin(event) {
  event.preventDefault();
  const password = els.accessPassword?.value || "";
  if (!password.trim()) {
    if (els.accessError) els.accessError.textContent = "先输入访问密码。";
    return;
  }

  const button = els.accessForm?.querySelector("button");
  if (button) setBusy(button, "验证中...");
  try {
    const response = await fetch("/api/access/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const { payload } = await readAPIResponse(response, { showGate: false });
    if (!response.ok) throw new Error(payload.error || "访问密码不正确。");
    if (els.accessPassword) els.accessPassword.value = "";
    hideAccessGate();
    initApp();
  } catch (error) {
    showAccessGate(error.message || "访问密码不正确。");
  } finally {
    if (button) restoreButton(button, "进入生产台");
  }
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanTopic(topic) {
  return topic.trim() || "AI 做图总翻车的 3 个原因";
}

function selectedVisualStyle() {
  return state.selectedStyle || els.style.value;
}

function setSelectedStyle(style) {
  state.selectedStyle = style || els.style.value;
  const matchingOption = [...els.style.options].find((option) => option.value === state.selectedStyle);
  if (matchingOption) els.style.value = state.selectedStyle;
}

function syncStyleNote() {
  state.styleNote = els.styleNote?.value.trim() || "";
}

function savedPageFor(index) {
  return state.savedPages[String(index)] || state.savedPages[index];
}

function withCacheBuster(webPath) {
  return `${webPath}${webPath.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

function publishText() {
  if (!state.copy) return "生成文案后，这里会自动整理发布信息。";

  const imageLines = state.pages.length
    ? state.pages
        .map((page, index) => {
          const pageNumber = index + 1;
          const saved = savedPageFor(pageNumber);
          const filename = saved?.filename || `page-${String(pageNumber).padStart(2, "0")}.png`;
          return `- ${filename} ${saved ? "已保存" : "待生成"}：${page.title}`;
        })
        .join("\n")
    : "- 等待生成图片";

  const folderLine = state.outputSession?.folderPath
    ? `\n## 本地文件夹\n${state.outputSession.folderPath}\n`
    : "";

  return `# ${state.copy.title}

${state.copy.opening}

${state.copy.body}

## 图片
${imageLines}

## 话题
${state.copy.hashtags.map((tag) => `#${tag}`).join(" ")}

## 备注
- 风格：${selectedVisualStyle()}
- 图片尺寸：3:4
- 文案生成：${copyProvider.name}
- 生成方式：${image2Provider.name}
${folderLine}`;
}

function persistDraft() {
  const draft = {
    topic: els.topic.value,
    material: els.material.value,
    persona: els.persona.value,
    style: els.style.value,
    selectedStyle: selectedVisualStyle(),
    styleNote: state.styleNote,
    phase: state.phase,
    maxStep: state.maxStep,
    copy: state.copy,
    pages: state.pages,
    imageJobs: state.imageJobs,
    outputSession: state.outputSession,
    savedPages: state.savedPages,
  };
  localStorage.setItem("xhs-note-studio-draft", JSON.stringify(draft));
}

function restoreDraft() {
  const raw = localStorage.getItem("xhs-note-studio-draft");
  if (!raw) return;

  try {
    const draft = JSON.parse(raw);
    if (!draft?.copy || !Array.isArray(draft.pages) || !draft.pages.length) return;
    els.topic.value = draft.topic || els.topic.value;
    els.material.value = draft.material || els.material.value;
    els.persona.value = draft.persona || els.persona.value;
    els.style.value = draft.style || els.style.value;
    setSelectedStyle(draft.selectedStyle || draft.style || els.style.value);
    state.styleNote = draft.styleNote || "";
    if (els.styleNote) els.styleNote.value = state.styleNote;
    state.copy = draft.copy;
    state.pages = draft.pages;
    state.imageJobs = draft.imageJobs || {};
    state.outputSession = draft.outputSession || null;
    state.savedPages = draft.savedPages || {};
    state.phase = draft.phase || "script";
    state.maxStep = draft.maxStep || (state.outputSession ? "publish" : "script");
    state.view = state.phase === "publish" ? "publish" : "script";
    state.previewItems = buildSavedPreviewItems();
    if (!state.previewItems.length) {
      state.previewItems = state.pages.map((page, index) => ({
        id: `script-${index + 1}`,
        page,
        html: renderArtwork(page, index),
      }));
    }
    renderCopy();
    renderPages();
    renderSamplesEmpty();
    renderPublishBox();
  } catch {
    localStorage.removeItem("xhs-note-studio-draft");
  }
}

async function createOrUpdateOutputSession(sessionId) {
  const previousSavedPages = state.savedPages || {};
  const body = {
    title: state.copy.title,
    copy: {
      ...state.copy,
      copyProvider: copyProvider.name,
      imageProvider: image2Provider.name,
    },
    pages: state.pages,
    style: selectedVisualStyle(),
    publishText: publishText(),
  };
  if (sessionId) body.sessionId = sessionId;

  const response = await fetch("/api/output/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const { payload } = await readAPIResponse(response);
  if (!response.ok) throw new Error(payload.error || "输出文件夹创建失败");
  state.outputSession = {
    sessionId: payload.sessionId,
    folderPath: payload.folderPath,
  };
  const serverSavedPages = payload.manifest?.savedPages || {};
  state.savedPages = Object.keys(serverSavedPages).length ? serverSavedPages : previousSavedPages;
  persistDraft();
  renderPublishBox();
  return state.outputSession;
}

async function ensureOutputSession() {
  if (!state.copy) return null;
  if (state.outputSession?.sessionId) return state.outputSession;
  return createOrUpdateOutputSession();
}

async function refreshOutputSession() {
  if (!state.outputSession?.sessionId) return null;
  const response = await fetch(`/api/output/session?sessionId=${encodeURIComponent(state.outputSession.sessionId)}`);
  const { payload } = await readAPIResponse(response);
  if (!response.ok) return null;
  state.outputSession.folderPath = payload.folderPath;
  state.savedPages = payload.manifest?.savedPages || {};
  persistDraft();
  return payload.manifest;
}

async function savePageImage(item, pageIndex) {
  await ensureOutputSession();
  await cachePageImage(pageIndex, item.imageUrl);
  const response = await fetch("/api/output/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: state.outputSession.sessionId,
      pageIndex,
      title: item.page.title,
      imageUrl: item.imageUrl,
      prompt: item.prompt,
      mode: item.mode || "full",
      style: item.style || selectedVisualStyle(),
    }),
  });
  const { payload } = await readAPIResponse(response);
  if (!response.ok) throw new Error(payload.error || "图片保存失败");

  state.savedPages = payload.manifest?.savedPages || {
    ...state.savedPages,
    [String(pageIndex)]: payload.savedPage,
  };
  item.savedFile = payload.savedPage;
  item.imageUrl = withCacheBuster(payload.savedPage.webPath);
  item.html = renderImageArtwork(item.page, item.imageUrl);
  renderPublishBox();
  persistDraft();
  return payload.savedPage;
}

function buildSavedPreviewItems() {
  return state.pages
    .map((page, index) => {
      const saved = savedPageFor(index + 1);
      if (!saved?.webPath) return null;
      const imageUrl = withCacheBuster(saved.webPath);
      return {
        id: `full-${index + 1}`,
        pageIndex: index + 1,
        mode: "full",
        style: selectedVisualStyle(),
        page,
        imageUrl,
        html: renderImageArtwork(page, imageUrl),
        savedFile: saved,
      };
    })
    .filter(Boolean);
}

async function hydrateCachedImages() {
  if (!state.pages.length || !state.outputSession?.sessionId) return;

  const items = [];
  let restoredCount = 0;
  for (let index = 0; index < state.pages.length; index += 1) {
    const pageIndex = index + 1;
    const page = state.pages[index];
    const cachedImage = await readCachedPageImage(pageIndex);
    const saved = savedPageFor(pageIndex);
    const imageUrl = cachedImage || (saved?.webPath ? withCacheBuster(saved.webPath) : null);
    if (!imageUrl) continue;

    if (cachedImage) restoredCount += 1;
    items.push({
      id: `full-${pageIndex}`,
      pageIndex,
      mode: "full",
      style: selectedVisualStyle(),
      page,
      imageUrl,
      html: renderImageArtwork(page, imageUrl),
      savedFile: saved,
    });
  }

  if (!items.length) return;
  state.images = items;
  state.previewItems = items;
  state.selectedIndex = Math.min(state.selectedIndex, items.length - 1);
  renderPreview();
  renderPublishBox();
  if (restoredCount) toast("已恢复上次生成的图片。");
}

async function syncCachedImagesToServer() {
  if (!state.copy || !state.outputSession?.sessionId || !state.pages.length) return 0;

  const cachedPages = [];
  for (let index = 0; index < state.pages.length; index += 1) {
    const pageIndex = index + 1;
    const imageUrl = await readCachedPageImage(pageIndex);
    if (imageUrl) cachedPages.push({ pageIndex, page: state.pages[index], imageUrl });
  }

  if (!cachedPages.length) return 0;

  await createOrUpdateOutputSession(state.outputSession.sessionId);
  for (const item of cachedPages) {
    await savePageImage(
      {
        page: item.page,
        imageUrl: item.imageUrl,
        prompt: savedPageFor(item.pageIndex)?.prompt || "",
      },
      item.pageIndex
    );
  }
  return cachedPages.length;
}

function savedCount() {
  return Object.keys(state.savedPages || {}).length;
}

function isFullReady() {
  return state.pages.length > 0 && savedCount() >= state.pages.length;
}

function outputActionLabel() {
  return state.appMode === "web" ? "导出图片" : "打开文件夹";
}

function nextExportActionLabel() {
  if (state.phase === "idle") return "开始生成方案";
  if (state.phase === "script") return "下一步：生成 3 套样图";
  if (state.phase === "style") return `确认，按方案生成 ${state.pages.length || "若干"} 张`;
  return "继续生成剩余图片";
}

function showExportNeedsImages() {
  const targetStep = state.phase === "style" || state.maxStep === "style" ? "style" : "script";
  showStep(targetStep);
  const action = nextExportActionLabel();
  els.nextTitle.textContent = "还没有可下载的图片";
  els.nextText.textContent = `先点“${action}”，等图片生成出来后，再点“导出图片”。`;
  toast(`还没有图片，先点“${action}”。`);
}

async function generateCopyAndPages() {
  const topic = cleanTopic(els.topic.value);
  const material = els.material.value.trim();
  const persona = els.persona.value;
  const style = els.style.value;
  setSelectedStyle(style);

  setBusy(els.primaryFlow, "DeepSeek 写文案中...");
  try {
    const result = await copyProvider.generate({ topic, material, persona, style });
    state.copy = {
      title: result.title,
      coverTitle: result.coverTitle,
      opening: result.opening,
      body: result.body,
      hashtags: result.hashtags || [],
      persona,
      material,
    };

    state.pages = result.pages || [];
    state.samples = [];
    state.images = [];
    setSelectedStyle(style);
    state.outputSession = null;
    state.savedPages = {};
    state.previewItems = state.pages.map((page, index) => ({
      id: `script-${index + 1}`,
      page,
      html: renderArtwork(page, index),
    }));
    state.selectedIndex = 0;

    renderCopy();
    renderPages();
    renderPreview();
    renderSamplesEmpty();
    renderPublishBox();
    state.phase = "script";
    state.maxStep = "script";
    await ensureOutputSession();
    showStep("script");
    toast("文案方案已生成，输出文件夹也准备好了。");
  } catch (error) {
    state.copy = null;
    state.pages = [];
    state.outputSession = null;
    state.savedPages = {};
    state.previewItems = [];
    renderCopyError(error.message || "DeepSeek 文案生成失败");
    renderSamplesEmpty();
    renderPublishBox();
    toast(error.message || "DeepSeek 文案生成失败");
  } finally {
    persistDraft();
    restoreButton(els.primaryFlow, "开始生成方案");
    updatePrimaryButton();
    updateGuide();
  }
}

function renderCopy() {
  const copy = state.copy;
  els.copyOutput.innerHTML = `
    <strong>标题：</strong>${escapeHTML(copy.title)}<br />
    <strong>封面：</strong>${escapeHTML(copy.coverTitle || copy.title)}<br />
    <strong>开头：</strong>${escapeHTML(copy.opening)}<br />
    <strong>正文：</strong>${escapeHTML(copy.body)}<br />
    <strong>话题：</strong>${copy.hashtags.map((tag) => `#${escapeHTML(tag)}`).join(" ")}
  `;
  els.pageCount.textContent = `${state.pages.length} 张`;
}

function renderCopyError(message) {
  els.copyOutput.innerHTML = `
    <div class="error-state">
      <strong>文案还没生成成功</strong>
      <p>${escapeHTML(message)}</p>
      <small>请确认 DeepSeek API Key 已配置，或者稍后重试。</small>
    </div>
  `;
  els.pageList.innerHTML = "";
  els.pageCount.textContent = "生成失败";
}

function renderPages() {
  els.pageList.innerHTML = state.pages
    .map(
      (page, index) => {
        const pageNumber = index + 1;
        const prompt = buildImagePrompt(page, selectedVisualStyle(), {
          mode: "full",
          pageIndex: pageNumber,
          totalPages: state.pages.length,
          pagePlan: state.pages,
          visualContract: buildVisualContract(selectedVisualStyle(), state.pages),
          styleNote: state.styleNote,
        });
        return `
        <article class="page-item editable-page" data-page-index="${index}">
          <span>${pageNumber} / ${pageTypeLabel(page)} · ${savedPageFor(pageNumber) ? "已保存" : "待生成"}</span>
          <label>
            <em>图上标题</em>
            <input data-page-field="title" value="${escapeHTML(page.title)}" />
          </label>
          <label>
            <em>副标题</em>
            <input data-page-field="subtitle" value="${escapeHTML(page.subtitle)}" />
          </label>
          <label>
            <em>这一页怎么画</em>
            <textarea data-page-field="visualIntent" rows="2">${escapeHTML(page.visualIntent || "")}</textarea>
          </label>
          <label>
            <em>页面要点</em>
            <textarea data-page-field="points" rows="3">${escapeHTML((page.points || []).join("\n"))}</textarea>
          </label>
          <details class="prompt-preview">
            <summary>查看这一张会发给 Image2 的提示词</summary>
            <pre>${escapeHTML(prompt)}</pre>
          </details>
        </article>
      `;
      }
    )
    .join("");
}

function pageTypeLabel(page) {
  if (page.type === "cover") return "封面";
  if (page.type === "ending") return "结尾页";
  return "正文页";
}

function handlePageEdit(event) {
  const field = event.target?.dataset?.pageField;
  if (!field) return;
  const card = event.target.closest("[data-page-index]");
  const pageIndex = Number(card?.dataset.pageIndex);
  const page = state.pages[pageIndex];
  if (!page) return;

  if (field === "points") {
    page.points = event.target.value
      .split(/\r?\n/)
      .map((point) => point.trim())
      .filter(Boolean)
      .slice(0, 6);
  } else {
    page[field] = event.target.value;
  }

  invalidateGeneratedImages();
  state.previewItems = state.pages.map((candidate, index) => ({
    id: `script-${index + 1}`,
    page: candidate,
    html: renderArtwork(candidate, index),
  }));
  state.selectedIndex = Math.min(state.selectedIndex, state.previewItems.length - 1);
  renderPreview();
  renderPublishBox();
  persistDraft();
}

function invalidateGeneratedImages() {
  state.samples = [];
  state.images = [];
  state.savedPages = {};
  state.outputSession = null;
  state.imageJobs = {};
  if (state.phase !== "idle") state.phase = "script";
  state.maxStep = "script";
  state.view = "script";
  renderSamplesEmpty();
  setStep("script");
  renderPanels();
  updatePrimaryButton();
  updateGuide();
}

async function generateStyleSamples() {
  if (!(await ensureScript())) return;
  syncStyleNote();
  await ensureOutputSession();
  const styleOptions = getSampleStyleOptions(els.style.value);
  const bodyPage = state.pages.find((page) => page.type !== "cover") || state.pages[1] || state.pages[0];
  const samplePages = [state.pages[0], bodyPage].filter(Boolean);
  const totalSamples = styleOptions.length * samplePages.length;
  const validStyleIds = new Set(styleOptions.map((option) => option.id));
  state.samples = state.samples.filter((item) => item.sampleStyle?.id && validStyleIds.has(item.sampleStyle.id));
  setBusy(els.primaryFlow, "生成 3 套样图中...");
  try {
    for (let optionIndex = 0; optionIndex < styleOptions.length; optionIndex += 1) {
      const option = styleOptions[optionIndex];
      for (let localIndex = 0; localIndex < samplePages.length; localIndex += 1) {
        const sampleId = `sample-${option.id}-${localIndex + 1}`;
        if (state.samples.some((item) => item.id === sampleId)) continue;

        const globalIndex = optionIndex * samplePages.length + localIndex;
        const visualContract = buildVisualContract(option.name, samplePages);
        await image2Provider.generate({
          pages: [samplePages[localIndex]],
          style: option.name,
          mode: "sample",
          pagePlan: samplePages,
          visualContract,
          startIndex: globalIndex,
          progressTotal: totalSamples,
          promptTotalPages: samplePages.length,
          onProgress: ({ current, total, title }) => {
            els.primaryFlow.textContent = `生成样图... ${current}/${total}`;
            els.publishBox.textContent = `正在生成「${option.label}」样图：${title}\n\n成功一张就会保留；中途断了，再点主按钮只补缺的样图。`;
          },
          onGenerated: async (item) => {
            state.samples.push({
              ...item,
              id: sampleId,
              sampleStyle: option,
              samplePageRole: localIndex === 0 ? "封面" : "正文",
            });
            renderSampleGrid();
            persistDraft();
          },
        });
      }
    }
    const firstCompleteStyle =
      styleOptions.find((option) =>
        samplePages.every((_, index) => state.samples.some((item) => item.id === `sample-${option.id}-${index + 1}`))
      ) || styleOptions[0];
    setSelectedStyle(firstCompleteStyle.name);
    state.previewItems = state.samples.filter((item) => item.style === selectedVisualStyle());
    state.selectedIndex = 0;
    renderPages();
    renderSampleGrid();
    renderPreview();
    renderPublishBox();
    state.phase = "style";
    state.maxStep = "style";
    showStep("style");
    toast("3 套样图已生成，点喜欢的样图就会作为最终风格。");
  } catch (error) {
    state.maxStep = "style";
    if (state.samples.length) {
      const firstSample = state.samples[0];
      setSelectedStyle(firstSample.style);
      state.previewItems = state.samples.filter((item) => item.style === selectedVisualStyle());
      state.selectedIndex = 0;
      renderPreview();
    }
    renderSampleError(error.message || "Image2 样图生成失败");
    showStep("style");
    toast(error.message || "Image2 样图生成失败");
  } finally {
    persistDraft();
    restoreButton(els.primaryFlow, "确认并生成全套");
    updatePrimaryButton();
    updateGuide();
  }
}

async function generateFullNote() {
  if (!(await ensureScript())) return;
  syncStyleNote();
  await ensureOutputSession();
  const serverManifest = await refreshOutputSession();
  if (!serverManifest && savedCount()) {
    const restoredCount = await syncCachedImagesToServer();
    if (!restoredCount) state.savedPages = {};
  }
  const missingPages = state.pages
    .map((page, index) => ({ page, pageIndex: index + 1 }))
    .filter(({ pageIndex }) => !savedPageFor(pageIndex));
  state.phase = "publish";
  state.maxStep = "publish";

  if (!missingPages.length) {
    state.images = buildSavedPreviewItems();
    state.previewItems = state.images;
    state.selectedIndex = 0;
    renderPages();
    renderPreview();
    renderPublishBox();
    showStep("publish");
    toast(`完整 ${state.images.length} 张图片已在输出文件夹里。`);
    updatePrimaryButton();
    updateGuide();
    return;
  }

  setBusy(els.primaryFlow, `继续生成... ${savedCount()}/${state.pages.length}`);
  try {
    const finalStyle = selectedVisualStyle();
    const visualContract = buildVisualContract(finalStyle, state.pages);
    for (const { page, pageIndex } of missingPages) {
      await image2Provider.generate({
        pages: [page],
        style: finalStyle,
        mode: "full",
        pagePlan: state.pages,
        visualContract,
        startIndex: pageIndex - 1,
        progressTotal: state.pages.length,
        promptTotalPages: state.pages.length,
        onProgress: ({ current, title }) => {
          els.primaryFlow.textContent = `生成并保存... ${current}/${state.pages.length}`;
          els.publishBox.textContent = `正在生成第 ${current}/${state.pages.length} 张：${title}\n\n成功一张就会立刻保存。中途卡住后，再点主按钮会继续补剩下的。`;
        },
        onGenerated: async (item) => {
          await savePageImage(item, pageIndex);
          await refreshOutputSession();
          state.images = buildSavedPreviewItems();
          state.previewItems = state.images;
          renderPages();
          renderPreview();
        },
      });
    }
    state.images = buildSavedPreviewItems();
    state.previewItems = state.images;
    state.selectedIndex = 0;
    renderPages();
    renderPreview();
    renderPublishBox();
    state.phase = "publish";
    state.maxStep = "publish";
    showStep("publish");
    toast(`完整 ${state.images.length} 张图片已生成并保存。`);
  } catch (error) {
    renderPublishError(error.message || "Image2 全套生成失败");
    state.maxStep = "publish";
    showStep("publish");
    toast(error.message || "Image2 全套生成失败");
  } finally {
    persistDraft();
    restoreButton(els.primaryFlow, isFullReady() ? "重新生成方案" : "继续生成剩余图片");
    updatePrimaryButton();
    updateGuide();
  }
}

async function ensureScript() {
  if (!state.pages.length) {
    await generateCopyAndPages();
  }
  return state.pages.length > 0;
}

function renderSamplesEmpty() {
  els.sampleGrid.innerHTML =
    '<div class="empty-state">生成样图后，会出现 3 套风格，每套包含封面和正文页。</div>';
}

function renderSampleGrid() {
  const groups = [];
  for (const item of state.samples) {
    let group = groups.find((candidate) => candidate.style === item.style);
    if (!group) {
      group = {
        style: item.style,
        label: item.sampleStyle?.label || item.style,
        items: [],
      };
      groups.push(group);
    }
    group.items.push(item);
  }

  els.sampleGrid.innerHTML = groups
    .map((group) => {
      const active = group.style === selectedVisualStyle();
      return `
        <article class="sample-set ${active ? "active" : ""}" data-style="${escapeHTML(group.style)}">
          <div class="sample-set-head">
            <div>
              <strong>${escapeHTML(group.label)}</strong>
              <span>封面 + 正文样图，点击任意一张选择这套</span>
            </div>
            <em>${active ? "已选" : "可选"}</em>
          </div>
          <div class="sample-pair">
            ${group.items
              .map((item) => {
                const index = state.samples.indexOf(item);
                return `
                  <button class="sample-card ${active ? "active" : ""}" data-index="${index}" aria-label="选择${escapeHTML(group.label)}${escapeHTML(item.samplePageRole || "")}样图">
                    <span class="sample-label">${escapeHTML(item.samplePageRole || "")}</span>
                    ${item.html}
                  </button>
                `;
              })
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");

  els.sampleGrid.querySelectorAll(".sample-card").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedSample = state.samples[Number(button.dataset.index)];
      setSelectedStyle(selectedSample?.style || els.style.value);
      state.previewItems = state.samples.filter((item) => item.style === selectedVisualStyle());
      state.selectedIndex = Math.max(0, state.previewItems.findIndex((item) => item.id === selectedSample?.id));
      persistDraft();
      renderSampleGrid();
      renderPreview();
      updatePrimaryButton();
      updateGuide();
      toast(`已选择：${selectedVisualStyle()}`);
    });
  });
}

function renderSampleError(message) {
  const errorHTML = `
    <div class="error-state">
      <strong>图片还没生成成功</strong>
      <p>${escapeHTML(message)}</p>
      <small>已经出现的样图会先保留。点左下角主按钮会继续补缺的样图。</small>
    </div>
  `;
  if (state.samples.length) {
    renderSampleGrid();
    els.sampleGrid.insertAdjacentHTML("beforeend", errorHTML);
    return;
  }
  els.sampleGrid.innerHTML = errorHTML;
}

function renderPublishError(message) {
  els.publishBox.textContent = `图片生成卡住了：${message}\n\n已经成功的图片会保留在输出文件夹里。处理好接口或网络后，点“继续生成剩余图片”会只补缺的页。`;
}

function renderPreview() {
  const items = state.previewItems.length ? state.previewItems : [];
  if (!items.length) {
    els.previewStatus.textContent = providerLabel();
    return;
  }

  const item = items[state.selectedIndex] || items[0];
  els.preview.innerHTML = item.html;
  els.previewStatus.textContent =
    item.mode === "full"
      ? `Image2 全套 · ${selectedVisualStyle()}`
      : item.mode === "sample"
      ? `Image2 样图 · ${selectedVisualStyle()}`
      : "方案预览";

  els.thumbStrip.innerHTML = items
    .map(
      (thumb, index) => `
        <button class="thumb ${index === state.selectedIndex ? "active" : ""}" data-index="${index}" aria-label="查看第 ${index + 1} 张">
          ${thumb.html}
        </button>
      `
    )
    .join("");

  els.thumbStrip.querySelectorAll(".thumb").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedIndex = Number(button.dataset.index);
      renderPreview();
    });
  });
}

function renderArtwork(page, index) {
  const isCover = page.type === "cover";
  const pointItems = page.points.map((point) => `<li>${escapeHTML(point)}</li>`).join("");
  const diagram = isCover
    ? `<div class="mini-diagram">
        <span>用户</span>
        <b>+</b>
        <span>用途</span>
      </div>`
    : `<div class="mini-diagram">
        <span>模糊提示词</span>
        <b>→</b>
        <span>明确 Brief</span>
      </div>`;

  return `
    <div class="note-artwork ${isCover ? "cover" : "body"}">
      <div class="artwork-inner">
        <div class="artwork-kicker">${isCover ? "AI 图文避坑指南" : `Page ${index + 1}`}</div>
        <h3 class="artwork-title">${escapeHTML(page.title)}</h3>
        <p class="artwork-subtitle">${escapeHTML(page.subtitle)}</p>
        ${diagram}
        <div class="artwork-card">
          <ul>${pointItems}</ul>
        </div>
      </div>
    </div>
  `;
}

function renderImageArtwork(page, imageUrl) {
  return `
    <div class="image-artwork">
      <img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(page.title)}" />
    </div>
  `;
}

function renderPublishBox() {
  if (!state.copy) {
    els.publishBox.textContent = "等待生成完整图文后自动整理。";
    return;
  }

  els.publishBox.textContent = `${publishText()}

## ${state.appMode === "web" ? "下载" : "本地输出"}
${state.appMode === "web" ? "生成完整图片后，点左下角“导出图片”，会下载 PNG 和文案压缩包。刷新页面会尽量从当前浏览器恢复图片；长期留存请及时下载。" : "图片会一张张保存到本地文件夹。点左下角“打开文件夹”可以直接查看。"}
`;
}

async function exportPackage() {
  if (!state.copy) {
    await generateCopyAndPages();
    if (!state.copy) return;
  }

  await ensureOutputSession();

  if (state.appMode === "local") {
    setBusy(els.exportPackage, "打开中...");
    try {
      const response = await fetch("/api/output/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.outputSession.sessionId }),
      });
      const { payload } = await readAPIResponse(response);
      if (!response.ok) throw new Error(payload.error || "打开文件夹失败");
      toast("已打开输出文件夹。");
    } catch (error) {
      toast(error.message || "打开文件夹失败");
    } finally {
      restoreButton(els.exportPackage, outputActionLabel());
    }
    return;
  }

  if (!savedCount()) {
    showExportNeedsImages();
    return;
  }

  setBusy(els.exportPackage, "准备下载...");
  try {
    let serverManifest = await refreshOutputSession();
    const restoredCount = await syncCachedImagesToServer();
    if (restoredCount) {
      serverManifest = await refreshOutputSession();
      state.images = buildSavedPreviewItems();
      state.previewItems = state.images;
      renderPreview();
    }

    if (!serverManifest || !Object.keys(serverManifest.savedPages || {}).length) {
      renderPublishError("网页服务器已经重启，之前的图片文件不在服务器上了。请点“继续生成剩余图片”重新补图。");
      toast("旧图片已失效，请点主按钮继续补图。");
      return;
    }

    const sessionId = encodeURIComponent(state.outputSession.sessionId);
    window.location.href = `/api/output/download?sessionId=${sessionId}`;
    toast("已开始下载，请查看浏览器下载列表。");
  } catch (error) {
    toast(error.message || "导出失败");
  } finally {
    window.setTimeout(() => restoreButton(els.exportPackage, outputActionLabel()), 1200);
  }
}

async function runPrimaryFlow() {
  if (state.phase === "idle") {
    await generateCopyAndPages();
    return;
  }

  if (state.phase === "script") {
    await generateStyleSamples();
    return;
  }

  if (state.phase === "style") {
    if (state.view !== "style") {
      showStep("style");
      return;
    }
    await generateFullNote();
    return;
  }

  if (state.phase === "publish") {
    if (state.view !== "publish") {
      showStep("publish");
      return;
    }
    if (isFullReady()) {
      await generateCopyAndPages();
      return;
    }
    await generateFullNote();
  }
}

function updatePrimaryButton() {
  if (state.phase === "idle") {
    els.primaryFlow.textContent = "开始生成方案";
    return;
  }

  if (state.phase === "script") {
    els.primaryFlow.textContent = "下一步：生成 3 套样图";
    return;
  }

  if (state.phase === "style") {
    els.primaryFlow.textContent =
      state.view === "style" ? `确认，按方案生成 ${state.pages.length || "若干"} 张` : "回到第 2 步看样图";
    return;
  }

  if (state.phase === "publish") {
    els.primaryFlow.textContent = state.view === "publish"
      ? isFullReady()
        ? "重新生成方案"
        : "继续生成剩余图片"
      : "回到第 3 步拿结果";
  }
}

function updateGuide() {
  const guides = {
    script: {
      title: state.phase === "idle" ? "第 1 步：先生成图文方案" : "第 1 步结果：图文方案",
      text:
        state.phase === "idle"
          ? "填完左边两项，点主按钮。DeepSeek 会先生成标题、正文、话题和每张图的大概内容。"
          : `这里是标题、正文和 ${state.pages.length || "若干"} 张图的拆页方案。每张图的标题、要点和画面提示都可以直接改。`,
    },
    style: {
      title: "第 2 步：先看 3 套样图",
      text:
        state.phase === "script"
          ? "点主按钮生成 3 套风格样图。中途断了也会保留已出的样图，下一次只补缺的。"
          : `当前选择：${selectedVisualStyle()}。可以写一句风格微调，满意后按方案生成 ${state.pages.length || "若干"} 张。`,
    },
    publish: {
      title: "第 3 步：拿完整结果",
      text:
        state.phase === "publish"
          ? state.appMode === "web"
            ? "右边可以切换查看完整图片。成功一张会保存一张，中途断了点主按钮继续补。"
            : "右边可以切换查看完整图片。成功一张会保存一张，点左下角打开输出文件夹。"
          : "生成完整图片后，这里会出现输出说明。",
    },
  };
  const guide = guides[state.view] || guides.script;
  els.nextTitle.textContent = guide.title;
  els.nextText.textContent = guide.text;
}

function providerLabel() {
  if (state.copyProviderStatus === "ready" && state.providerStatus === "ready") return "DeepSeek + Image2 已连接";
  if (state.copyProviderStatus === "error" && state.providerStatus === "error") return "AI 接口未连接";
  if (state.copyProviderStatus === "error") return "DeepSeek 未连接";
  if (state.providerStatus === "error") return "Image2 未连接";
  return "连接中";
}

async function checkProvider() {
  const [copyResult, imageResult, appResult] = await Promise.allSettled([
    fetch("/api/copy/status").then((response) => readAPIResponse(response)),
    fetch("/api/image2/models").then((response) => readAPIResponse(response)),
    fetch("/api/app/status").then((response) => readAPIResponse(response)),
  ]);

  if (appResult.status === "fulfilled" && appResult.value.response.ok) {
    state.appMode = appResult.value.payload.mode || "local";
    state.canOpenFolder = Boolean(appResult.value.payload.canOpenFolder);
  }

  state.copyProviderStatus =
    copyResult.status === "fulfilled" && copyResult.value.response.ok && copyResult.value.payload.configured ? "ready" : "error";
  state.providerStatus = imageResult.status === "fulfilled" && imageResult.value.response.ok ? "ready" : "error";

  const label = providerLabel();
  document.querySelector(".topbar-status span:last-child").textContent = label;
  document.querySelector(".api-card > span").textContent =
    state.copyProviderStatus === "ready" && state.providerStatus === "ready" ? "Ready" : "未连接";
  document.querySelector(".api-card p:last-child").textContent =
    state.copyProviderStatus === "ready" && state.providerStatus === "ready"
      ? `已连接 DeepSeek ${copyResult.value.payload.model} + BananaRouter gpt-image-2。`
      : "请用本地 App 启动，并配置 DeepSeek 与 Image2 API Key。";
  els.exportPackage.textContent = outputActionLabel();
  renderPublishBox();
  updateGuide();
  renderPreview();
}

function canOpenStep(stepName) {
  const order = { script: 1, style: 2, publish: 3 };
  return order[stepName] <= order[state.maxStep];
}

function showStep(stepName) {
  if (!canOpenStep(stepName)) {
    toast("这一步还没生成，先按主按钮继续。");
    return;
  }

  state.view = stepName;
  setStep(stepName);
  renderPanels();
  updatePrimaryButton();
  updateGuide();
}

function renderPanels() {
  els.panels.forEach((panel) => {
    panel.classList.toggle("active-panel", panel.dataset.panel === state.view);
  });
}

function setStep(stepName) {
  els.steps.querySelectorAll(".step").forEach((step) => {
    const locked = !canOpenStep(step.dataset.step);
    step.classList.toggle("active", step.dataset.step === stepName);
    step.classList.toggle("locked", locked);
    step.disabled = locked;
  });
}

function setBusy(button, label) {
  button.dataset.originalText = button.textContent;
  button.textContent = label;
  button.disabled = true;
}

function restoreButton(button, fallback) {
  button.textContent = button.dataset.originalText || fallback;
  button.disabled = false;
}

function toast(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  window.setTimeout(() => node.remove(), 2200);
}

let eventsBound = false;
let appInitialized = false;

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  els.accessForm?.addEventListener("submit", handleAccessLogin);
  els.primaryFlow.addEventListener("click", runPrimaryFlow);
  els.exportPackage.addEventListener("click", exportPackage);
  els.pageList.addEventListener("input", handlePageEdit);
  els.style.addEventListener("change", () => {
    setSelectedStyle(els.style.value);
    renderPages();
    persistDraft();
    updateGuide();
  });
  els.styleNote?.addEventListener("input", () => {
    syncStyleNote();
    renderPages();
    persistDraft();
  });
  els.steps.querySelectorAll(".step").forEach((step) => {
    step.addEventListener("click", () => showStep(step.dataset.step));
  });
}

function initApp() {
  if (appInitialized) return;
  appInitialized = true;
  setSelectedStyle(els.style.value);
  syncStyleNote();
  restoreDraft();
  updatePrimaryButton();
  updateGuide();
  renderPanels();
  setStep(state.view);
  checkProvider().finally(() => hydrateCachedImages());
}

async function startApp() {
  bindEvents();
  try {
    const canEnter = await checkAccessGate();
    if (canEnter) initApp();
  } catch {
    showAccessGate("暂时无法确认访问状态，请刷新后再试。");
  }
}

startApp();
