const sampleStyles = [
  {
    id: "light-note",
    name: "浅色轻手账信息卡风",
    label: "A 轻手账信息卡",
    description:
      "浅暖白背景，像清爽教程笔记和信息卡片的结合；亲近、小白友好，但成熟、克制、专业。",
    system:
      "背景 #f7f3ea，主文字 #252927，辅助文字 #68706b，强调色 #f2bd2f；统一使用细线信息卡、浅色便签块、克制手绘箭头，圆角 18px 左右，阴影很轻。",
  },
  {
    id: "minimal-workbook",
    name: "极简白底工具书风",
    label: "B 极简工具书",
    description:
      "白底、黑灰文字、少量黄绿色标注，像一本清楚的 AI 工具说明书；信息密度更高，页面更利落。",
    system:
      "背景 #fbfbf7，主文字 #1f2422，辅助文字 #666f69，强调色 #b7d66f 与 #f1c84b；统一使用网格排版、细边框模块、编号标签、流程线，几乎不使用贴纸。",
  },
  {
    id: "contrast-card",
    name: "高对比标题卡风",
    label: "C 高对比标题卡",
    description:
      "标题更有冲击力，白底或浅灰底，红黄只作为警示点缀；点击感强，但保持高级克制。",
    system:
      "背景 #f5f2ea，主文字 #171a18，辅助文字 #606762，强调色 #ef4444 与 #f6c445；统一使用强标题区、警示小标签、粗细对比线条、少量红黄提示块，避免廉价营销海报。",
  },
  {
    id: "dark-workbook",
    name: "深色工具书风",
    label: "D 深色工具书",
    description:
      "深色背景，专业、清爽、有 AI 工具感；用蓝白或青色点缀，强调长期栏目质感。",
    system:
      "背景 #12161d，主文字 #f4f7fb，辅助文字 #aeb8c5，强调色 #58c7f3 与 #d7f36b；统一使用深色面板、荧光细线、工具栏标签、清晰模块分区。",
  },
];

export function getSampleStyleOptions(baseStyle = "") {
  const matched = sampleStyles.find((style) => style.name === baseStyle || baseStyle.includes(style.name.replace("风", "")));
  const preferred = matched || sampleStyles[0];
  const fallbackOrder = ["light-note", "minimal-workbook", "contrast-card"];
  const ordered = [
    preferred,
    ...fallbackOrder
      .map((id) => sampleStyles.find((style) => style.id === id))
      .filter((style) => style && style.id !== preferred.id),
  ];
  return ordered.slice(0, 3);
}

export function getStyleGuide(style = "") {
  return (
    sampleStyles.find((item) => item.name === style || style.includes(item.name.replace("风", ""))) ||
    sampleStyles[0]
  );
}

function formatPagePlan(pages = []) {
  return pages
    .slice(0, 18)
    .map((page, index) => {
      const type = page.type === "cover" ? "封面" : page.type === "ending" ? "结尾页" : "正文页";
      const title = String(page.title || `第 ${index + 1} 页`).trim();
      return `${index + 1}. ${type}：${title}`;
    })
    .join(" / ");
}

export function buildImagePrompt(page, style, context = {}) {
  const styleGuide = getStyleGuide(style);
  const pageIndex = Number(context.pageIndex || 1);
  const totalPages = Number(context.totalPages || 1);
  const mode = context.mode || "full";
  const points = Array.isArray(page.points) ? page.points.filter(Boolean) : [];
  const pagePlan = Array.isArray(context.pagePlan) ? formatPagePlan(context.pagePlan) : "";

  return [
    "生成一张小红书竖版图文页面，比例 3:4，适合手机阅读。",
    `这是同一套小红书图文笔记的第 ${pageIndex} / ${totalPages} 页，模式：${mode === "sample" ? "风格样片" : "完整套图"}。`,
    pagePlan ? `全套页面目录：${pagePlan}` : "",
    `视觉风格：${styleGuide.name}。${styleGuide.description}`,
    `统一设计系统：${styleGuide.system}`,
    `页面类型：${page.type === "cover" ? "封面" : page.type === "ending" ? "结尾页" : "正文页"}`,
    `页面标题：${page.title || ""}`,
    `副标题：${page.subtitle || ""}`,
    `页面备注：${page.note || ""}`,
    `画面意图：${page.visualIntent || ""}`,
    `页面要点：${points.join("；")}`,
    "套图一致性强约束：所有页面必须像同一个账号栏目，用同一套背景颜色、标题层级、信息卡形状、图标线条、装饰元素、页码位置和留白节奏。",
    "系列母版：固定同一套页面骨架：顶部栏目/页码区，中部主信息卡，底部要点区；只替换内容和局部强调，不重新设计页面。",
    "封面和正文要像同一套模板延展：封面标题更强，正文继续沿用同样背景、线条、标签、图标、圆角尺度、阴影强度和边距比例。",
    "页码、栏目标签、角标、装饰线的位置必须保持相对一致；每页最多改变信息卡内部结构，不改变整体视觉系统。",
    "禁止每页换背景、换主色、换字体、换插画风格、换信息卡样式；不要一页像海报、一页像手账、一页像PPT。",
    "版式：上方大标题，中间用简洁信息卡片、流程线、轻量图标解释，底部放 2-3 条要点或总结。",
    "中文文字必须清晰可读，不要错字，不要乱码；标题醒目；正文页必须能承载信息。",
    "受众：内容创作者、AI 工具学习者、小红书新手。整体要像成熟创作者的教程栏目，不像儿童手账。",
    "禁止：不要卡通动物，不要可爱玩偶，不要幼稚贴纸，不要儿童绘本风，不要过度圆润 Q 版角色，不要廉价营销海报。",
    "画面语言：留白干净，边框克制，装饰少而准；可用细线手绘箭头、便签式信息块、淡色高亮，但不要堆贴纸。",
  ].join("\n");
}

export function buildCopyPrompt({ topic, material, persona, style }) {
  return [
    "你是小红书图文内容策划和文案编辑。请根据用户给的选题和语料，生成一份可确认的小红书图文发布包草稿。",
    "",
    "输出必须是严格 JSON，不要 Markdown，不要解释。",
    "JSON 字段：",
    "{",
    '  "title": "小红书发布标题，适合正文发布",',
    '  "coverTitle": "封面主标题，短、强、有点击理由",',
    '  "opening": "正文开头 1-2 句",',
    '  "body": "完整正文，口语化，有信息量，不要油腻营销",',
    '  "hashtags": ["话题1", "话题2"],',
    '  "pages": [',
    '    { "type": "cover|body|ending", "title": "页面标题", "subtitle": "页面副标题", "note": "页面备注", "points": ["2-4 个要点"], "visualIntent": "这一页画面应该表达什么" }',
    "  ]",
    "}",
    "",
    "要求：",
    "- 根据内容决定页数，不要固定 7 页；信息少用 4-6 页，正常教程用 6-9 页，复杂内容可用 10-12 页，小红书上限 18 页。",
    "- 必须包含 1 张封面；正文页数量按信息密度决定；只有在确实需要总结、行动清单或引导评论时才加结尾页。",
    "- 不要为了凑页数生成空话页，也不要把信息硬塞到太少页面里。",
    "- 每页标题要短，适合直接放在图上。",
    "- 正文页要能承载信息，不要只是情绪口号。",
    "- 话题 5-8 个，不要带 # 符号。",
    "- 风格要适配小红书，但不要幼稚、不要廉价营销感。",
    "- 如果语料不足，可以合理补全，但不要编造具体数据或案例。",
    "",
    `选题：${topic}`,
    `语料：${material}`,
    `账号感觉：${persona}`,
    `图片风格：${style}`,
  ].join("\n");
}

export function normalizeCopyPackage(value) {
  const pages = Array.isArray(value.pages) ? value.pages : [];
  if (!value.title || !value.body || !pages.length) {
    throw new Error("DeepSeek 返回的文案包缺少标题、正文或拆页");
  }

  return {
    title: String(value.title).trim(),
    coverTitle: String(value.coverTitle || value.title).trim(),
    opening: String(value.opening || "").trim(),
    body: String(value.body).trim(),
    hashtags: (Array.isArray(value.hashtags) ? value.hashtags : [])
      .map((tag) => String(tag).replace(/^#/, "").trim())
      .filter(Boolean)
      .slice(0, 8),
    pages: pages.slice(0, 18).map((page, index) => ({
      type: ["cover", "body", "ending"].includes(page.type) ? page.type : index === 0 ? "cover" : "body",
      title: String(page.title || `第 ${index + 1} 页`).trim(),
      subtitle: String(page.subtitle || "").trim(),
      note: String(page.note || "").trim(),
      points: (Array.isArray(page.points) ? page.points : [])
        .map((point) => String(point).trim())
        .filter(Boolean)
        .slice(0, 4),
      visualIntent: String(page.visualIntent || "").trim(),
    })),
  };
}
