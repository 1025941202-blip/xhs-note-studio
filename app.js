const $ = (selector) => document.querySelector(selector);

const els = {
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
  outputSession: null,
  savedPages: {},
};

const image2Provider = {
  name: "image2-gpt-image-2",
  async generate({ pages, style, mode, startIndex = 0, onProgress = () => {}, onGenerated = async () => {} }) {
    const results = [];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const prompt = buildImagePrompt(page, style);
      const pageIndex = startIndex + index + 1;
      onProgress({
        current: pageIndex,
        total: startIndex + pages.length,
        title: page.title,
      });
      const response = await fetch("/api/image2/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt,
          n: 1,
          size: "1024x1536",
          quality: "low",
          output_format: "png",
          moderation: "auto",
          response_format: "b64_json",
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Image2 生成失败");
      }

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
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "DeepSeek 文案生成失败");
    }
    return payload;
  },
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
- 风格：${els.style.value}
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
    phase: state.phase,
    maxStep: state.maxStep,
    copy: state.copy,
    pages: state.pages,
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
    state.copy = draft.copy;
    state.pages = draft.pages;
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

async function ensureOutputSession() {
  if (!state.copy) return null;
  if (state.outputSession?.sessionId) return state.outputSession;

  const response = await fetch("/api/output/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: state.copy.title,
      copy: {
        ...state.copy,
        copyProvider: copyProvider.name,
        imageProvider: image2Provider.name,
      },
      pages: state.pages,
      style: els.style.value,
      publishText: publishText(),
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "输出文件夹创建失败");
  state.outputSession = {
    sessionId: payload.sessionId,
    folderPath: payload.folderPath,
  };
  state.savedPages = payload.manifest?.savedPages || state.savedPages || {};
  persistDraft();
  renderPublishBox();
  return state.outputSession;
}

async function refreshOutputSession() {
  if (!state.outputSession?.sessionId) return null;
  const response = await fetch(`/api/output/session?sessionId=${encodeURIComponent(state.outputSession.sessionId)}`);
  const payload = await response.json();
  if (!response.ok) return null;
  state.outputSession.folderPath = payload.folderPath;
  state.savedPages = payload.manifest?.savedPages || {};
  persistDraft();
  return payload.manifest;
}

async function savePageImage(item, pageIndex) {
  await ensureOutputSession();
  const response = await fetch("/api/output/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: state.outputSession.sessionId,
      pageIndex,
      title: item.page.title,
      imageUrl: item.imageUrl,
      prompt: item.prompt,
    }),
  });
  const payload = await response.json();
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
        style: els.style.value,
        page,
        imageUrl,
        html: renderImageArtwork(page, imageUrl),
        savedFile: saved,
      };
    })
    .filter(Boolean);
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

async function generateCopyAndPages() {
  const topic = cleanTopic(els.topic.value);
  const material = els.material.value.trim();
  const persona = els.persona.value;
  const style = els.style.value;

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
      (page, index) => `
        <article class="page-item">
          <span>${index + 1} / ${page.type === "cover" ? "封面" : page.type === "ending" ? "结尾页" : "正文页"} · ${
        savedPageFor(index + 1) ? "已保存" : "待生成"
      }</span>
          <h3>${escapeHTML(page.title)}</h3>
          <p>${escapeHTML(page.subtitle)}</p>
        </article>
      `
    )
    .join("");
}

async function generateStyleSamples() {
  if (!(await ensureScript())) return;
  await ensureOutputSession();
  setBusy(els.primaryFlow, "生成样图中...");
  try {
    const samplePages = [state.pages[0], state.pages[1]];
    state.samples = await image2Provider.generate({
      pages: samplePages,
      style: els.style.value,
      mode: "sample",
      onProgress: ({ current, total }) => {
        els.primaryFlow.textContent = `生成并保存样图... ${current}/${total}`;
        els.publishBox.textContent = `正在生成第 ${current}/${state.pages.length} 张：样图会先保存到本地文件夹。`;
      },
      onGenerated: async (item, pageIndex) => {
        await savePageImage(item, pageIndex);
      },
    });
    await refreshOutputSession();
    state.previewItems = state.samples;
    state.selectedIndex = 0;
    renderPages();
    renderSampleGrid();
    renderPreview();
    renderPublishBox();
    state.phase = "style";
    state.maxStep = "style";
    showStep("style");
    toast("样图已生成，并保存到输出文件夹。");
  } catch (error) {
    state.maxStep = "style";
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
  await ensureOutputSession();
  await refreshOutputSession();
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
    for (const { page, pageIndex } of missingPages) {
      await image2Provider.generate({
        pages: [page],
        style: els.style.value,
        mode: "full",
        startIndex: pageIndex - 1,
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
    '<div class="empty-state">生成样图后，会出现 1 张封面和 1 张正文页。</div>';
}

function renderSampleGrid() {
  els.sampleGrid.innerHTML = state.samples
    .map(
      (item, index) => `
        <button class="sample-card" data-index="${index}" aria-label="查看样图 ${index + 1}">
          ${item.html}
        </button>
      `
    )
    .join("");

  els.sampleGrid.querySelectorAll(".sample-card").forEach((button) => {
    button.addEventListener("click", () => {
      state.previewItems = state.samples;
      state.selectedIndex = Number(button.dataset.index);
      renderPreview();
    });
  });
}

function renderSampleError(message) {
  els.sampleGrid.innerHTML = `
    <div class="error-state">
      <strong>图片还没生成成功</strong>
      <p>${escapeHTML(message)}</p>
      <small>请确认 Image2 账户可用，然后点左下角主按钮重试。</small>
    </div>
  `;
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
  els.previewStatus.textContent = item.mode === "full" ? "Image2 全套" : item.mode === "sample" ? "Image2 样图" : "方案预览";

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

function buildImagePrompt(page, style) {
  const styleGuide = getStyleGuide(style);
  return [
    "生成一张小红书竖版图文页面，比例 3:4，适合手机阅读。",
    `视觉风格：${styleGuide.name}。${styleGuide.description}`,
    `页面标题：${page.title}`,
    `副标题：${page.subtitle}`,
    `页面备注：${page.note || ""}`,
    `画面意图：${page.visualIntent || ""}`,
    `页面要点：${page.points.join("；")}`,
    "受众：内容创作者、AI 工具学习者、小红书新手。整体要像成熟创作者的教程栏目，不像儿童手账。",
    "必须做到：中文标题和要点清晰可读，不要错字，不要乱码；标题醒目；正文页能承载信息；封面和正文像同一套账号栏目。",
    "版式：上方大标题，中间用简洁信息卡片、流程线、轻量图标解释，底部放 2-3 条要点。",
    "禁止：不要卡通动物，不要可爱玩偶，不要幼稚贴纸，不要儿童绘本风，不要过度圆润 Q 版角色，不要廉价营销海报。",
    "画面语言：留白干净，边框克制，装饰少而准；可用细线手绘箭头、便签式信息块、淡色高亮，但不要堆贴纸。",
  ].join("\n");
}

function getStyleGuide(style) {
  if (style.includes("深色")) {
    return {
      name: "深色工具书风",
      description:
        "深色背景，专业、清爽、有 AI 工具感；用蓝白或青色点缀，强调长期栏目质感。",
    };
  }

  if (style.includes("高对比")) {
    return {
      name: "高对比流量风",
      description:
        "标题冲击强，白底或浅灰底，红黄只作为警示点缀；点击感强，但保持高级克制。",
    };
  }

  return {
    name: "浅色轻手账信息卡风",
    description:
      "浅色背景，像清爽教程笔记和信息卡片的结合；亲近、小白友好，但必须成熟、克制、专业。",
  };
}

function renderPublishBox() {
  if (!state.copy) {
    els.publishBox.textContent = "等待生成完整图文后自动整理。";
    return;
  }

  els.publishBox.textContent = `${publishText()}

## ${state.appMode === "web" ? "下载" : "本地输出"}
${state.appMode === "web" ? "生成完整图片后，点左下角“导出图片”，会下载 PNG 和文案压缩包。" : "图片会一张张保存到本地文件夹。点左下角“打开文件夹”可以直接查看。"}
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
      const payload = await response.json();
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
    showStep(state.samples.length ? "style" : "script");
    toast("先生成图片，再导出图片包。");
    return;
  }

  setBusy(els.exportPackage, "打包中...");
  try {
    const response = await fetch("/api/output/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.outputSession.sessionId,
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "导出失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${state.copy.title || "小红书图文"}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast("图片包已开始下载。");
  } catch (error) {
    toast(error.message || "导出失败");
  } finally {
    restoreButton(els.exportPackage, outputActionLabel());
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
    els.primaryFlow.textContent = "下一步：生成 2 张样图";
    return;
  }

  if (state.phase === "style") {
    els.primaryFlow.textContent = state.view === "style" ? `确认，生成完整 ${state.pages.length || 7} 张` : "回到第 2 步看样图";
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
          : "这里是标题、正文和 7 张图的拆页方案。想改选题或素材，就改左边后重新生成。",
    },
    style: {
      title: "第 2 步：先看 2 张样图",
      text:
        state.phase === "script"
          ? "点主按钮生成封面和正文页样图。满意再进入下一步，不满意就回第 1 步改素材或风格。"
          : "这是 Image2 生成的风格样图。满意后再生成完整 7 张。",
    },
    publish: {
      title: "第 3 步：拿完整结果",
      text:
        state.phase === "publish"
          ? state.appMode === "web"
            ? "右边可以切换查看完整图片。点左下角导出图片，会下载 PNG 和文案包。"
            : "右边可以切换查看完整图片。图片会自动保存，点左下角打开输出文件夹。"
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
    fetch("/api/copy/status").then((response) => response.json().then((payload) => ({ response, payload }))),
    fetch("/api/image2/models").then((response) => response.json().then((payload) => ({ response, payload }))),
    fetch("/api/app/status").then((response) => response.json().then((payload) => ({ response, payload }))),
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

els.primaryFlow.addEventListener("click", runPrimaryFlow);
els.exportPackage.addEventListener("click", exportPackage);
els.steps.querySelectorAll(".step").forEach((step) => {
  step.addEventListener("click", () => showStep(step.dataset.step));
});

restoreDraft();
updatePrimaryButton();
updateGuide();
renderPanels();
setStep(state.view);
checkProvider();
