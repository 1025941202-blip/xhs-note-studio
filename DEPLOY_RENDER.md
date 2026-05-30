# Render 正式部署步骤

这个项目适合用 Render 的 Blueprint 部署。仓库根目录里的 `render.yaml` 会创建一个 Node Web Service。

## 需要准备

- 一个 GitHub 仓库
- 一个 Render 账号
- 两个服务端环境变量：
  - `BANANAROUTER_API_KEY`
  - `DEEPSEEK_API_KEY`

不要把 API Key 写进代码、README 或前端文件。

## 部署流程

1. 把这个项目上传到 GitHub。
2. 打开 Render Dashboard。
3. 选择 New，然后选择 Blueprint。
4. 连接刚才的 GitHub 仓库。
5. Render 会读取根目录的 `render.yaml`。
6. 创建时填入：
   - `BANANAROUTER_API_KEY`
   - `DEEPSEEK_API_KEY`
7. 创建后等待部署完成。
8. 打开 Render 给出的 `onrender.com` 地址。

## Render 配置

`render.yaml` 已经设置：

- `APP_MODE=web`
- `HOST=0.0.0.0`
- 启动命令：`npm run start:web`

公网模式下，用户看到的是“导出图片”按钮，点击会下载 zip 图片包。

## 重要限制

当前版本没有登录和用量限制。正式给外部用户使用前，建议至少加一个访问码，否则别人生成图片会消耗你的 Image2 和 DeepSeek 额度。
