import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCopyPrompt,
  buildImagePrompt,
  buildVisualContract,
  getSampleStyleOptions,
  normalizeCopyPackage,
} from "../xhs-rules.mjs";

test("sample step offers three distinct style directions", () => {
  const options = getSampleStyleOptions("浅色轻手账信息卡风");

  assert.equal(options.length, 3);
  assert.equal(new Set(options.map((option) => option.name)).size, 3);
  assert.equal(options[0].name, "浅色轻手账信息卡风");
});

test("copy prompt lets content decide page count instead of forcing seven pages", () => {
  const prompt = buildCopyPrompt({
    topic: "AI 做图总翻车的 3 个原因",
    material: "用户、用途和风格边界没说清楚。",
    persona: "AI + IP 实战，小白友好",
    style: "浅色轻手账信息卡风",
  });

  assert.match(prompt, /根据内容决定页数/);
  assert.doesNotMatch(prompt, /默认拆成\s*7\s*页/);
});

test("normalization keeps DeepSeek page count and only caps at Xiaohongshu limit", () => {
  const packageDraft = normalizeCopyPackage({
    title: "标题",
    body: "正文",
    pages: Array.from({ length: 5 }, (_, index) => ({
      type: index === 0 ? "cover" : "body",
      title: `第 ${index + 1} 页`,
    })),
  });

  assert.equal(packageDraft.pages.length, 5);
});

test("full image prompt locks the carousel into one visual system", () => {
  const visualContract = buildVisualContract("极简白底工具书风", [
    { type: "cover", title: "AI 做图总翻车？" },
    { type: "body", title: "原因 1：没有说清楚用户是谁" },
    { type: "ending", title: "按这张清单改" },
  ]);
  const prompt = buildImagePrompt(
    {
      type: "body",
      title: "原因 1：没有说清楚用户是谁",
      subtitle: "同一个工具，不同用户要看的重点完全不同",
      note: "解释用户视角",
      points: ["先写给谁看", "再写他想解决什么"],
      visualIntent: "用信息卡解释用户画像",
    },
    "极简白底工具书风",
    {
      mode: "full",
      pageIndex: 2,
      totalPages: 6,
      visualContract,
      pagePlan: [
        { type: "cover", title: "AI 做图总翻车？" },
        { type: "body", title: "原因 1：没有说清楚用户是谁" },
        { type: "ending", title: "按这张清单改" },
      ],
    }
  );

  assert.match(prompt, /第 2 \/ 6 页/);
  assert.match(prompt, /全套页面目录/);
  assert.match(prompt, /统一设计系统/);
  assert.match(prompt, /系列母版/);
  assert.match(prompt, /禁止每页换背景/);
  assert.match(prompt, /视觉母版锁定/);
  assert.match(prompt, /全套页数与目录/);
});
