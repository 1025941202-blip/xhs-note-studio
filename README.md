# 小红书图文生产台 Demo

这是一个先跑通流程的小红书图文生产 Demo。它可以本地 App 使用，也可以用网页模式部署到公网。

## 当前能做什么

- 输入选题、语料、账号定位和默认风格
- 用 DeepSeek 生成标题、正文、话题和拆页方案
- 用一个主按钮按顺序确认文案、生成样图和完整图文
- 生成 7 张图文拆页
- 生成 1 张封面样图 + 1 张正文样图
- 确认后生成完整 7 张图文预览
- 每生成 1 张图，就立刻保存到输出目录，卡住后可以继续补剩余图片
- 本地 App 模式：打开输出文件夹
- 网页部署模式：导出 PNG 图片压缩包，并附带发布文案

## 启动方式

### 推荐：双击 App 启动

直接双击：

```text
小红书图文生产台.app
```

它会打开一个独立的 Mac 窗口，并自动启动本地服务。如果第一次没有配置 API Key，会弹窗让你输入，并保存到本机钥匙串。

备用方式：双击 `launch-app.command`，它会启动本地服务并用默认浏览器打开页面。

### 手动启动

不要用普通静态服务器启动。需要用本地代理服务保护 API Key：

```bash
BANANAROUTER_API_KEY="你的 Image2 API Key" DEEPSEEK_API_KEY="你的 DeepSeek API Key" node server.mjs
```

然后打开：

```text
http://127.0.0.1:4173/
```

## 还没有接什么

- 没有保存项目历史

## 部署到公网

这个 Demo 可以作为网页服务部署。服务器上需要配置环境变量：

```bash
APP_MODE=web
HOST=0.0.0.0
BANANAROUTER_API_KEY="你的 Image2 API Key"
DEEPSEEK_API_KEY="你的 DeepSeek API Key"
npm run start:web
```

公网模式下，按钮会显示为“导出图片”，用户点击后下载 zip 包；本地 App 模式下，按钮会显示为“打开文件夹”。

注意：API Key 仍然只放在服务端环境变量里，不要写进前端文件。

### 方案 A：Render 部署

这个目录已经包含 `render.yaml`。把项目推到 GitHub 后，在 Render 里选择 Blueprint，填入两个环境变量：

- `BANANAROUTER_API_KEY`
- `DEEPSEEK_API_KEY`

Render 会用 `npm run start:web` 启动。启动后，Render 给你的域名就是别人可以打开和使用的网页地址。

### 方案 B：Docker 部署

也可以用 Docker 跑在任意服务器上：

```bash
docker build -t xhs-note-studio .
docker run -p 4173:4173 \
  -e APP_MODE=web \
  -e HOST=0.0.0.0 \
  -e BANANAROUTER_API_KEY="你的 Image2 API Key" \
  -e DEEPSEEK_API_KEY="你的 DeepSeek API Key" \
  xhs-note-studio
```

然后把服务器的域名或公网 IP 反代到 `4173` 端口。

### 公网使用提醒

当前版本还没有登录、用量限制和计费隔离。如果把链接公开发出去，别人生成图片会消耗你的 Image2 和 DeepSeek 额度。小范围试用没问题；正式对外发布前，建议加访问码、用户系统或次数限制。

## DeepSeek 文案接入位置

当前已按 DeepSeek OpenAI 兼容格式接入：

- 默认模型：`deepseek-v4-flash`
- 文案接口：`POST https://api.deepseek.com/v1/chat/completions`
- 本地代理：`POST /api/copy/generate`

DeepSeek 返回的是结构化发布包：标题、封面标题、正文、话题和每页拆图内容。

## image2 API 接入位置

当前已按 BananaRouter 文档接入：

- 模型：`gpt-image-2`
- 文生图接口：`POST https://api.bananarouter.com/v1/images/generations`
- 返回格式：`data[0].b64_json`

前端调用本地代理：

```js
POST /api/image2/generate
```

## API Key 安全

不要把 image2 API Key 写进 `index.html` 或 `app.js` 这种浏览器可见文件里。
当前本地 App 启动器优先从 macOS 钥匙串读取 `Image2` 和 `DeepSeek` Key，也支持 `.env.local`。如果要用 `.env.local`，可以参考 `.env.local.example`。
