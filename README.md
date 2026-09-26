# CloudMail for Windows

CloudMail 是一个轻量的 Windows 原生邮箱管理客户端原型，基于 **Tauri 2 + Rust + React + TypeScript**。目标是快速打开、低内存占用，并为 `mail.kodao.site` 临时邮箱与 163 邮箱提供统一操作界面。

## 当前原型

- 深色 Windows 桌面布局：侧边栏、统一收件箱、邮件阅读区
- 邮件搜索和文件夹切换
- 验证码自动高亮示例与一键复制
- 新邮件窗口
- 账户与同步设置窗口
- 预留 `mail.kodao.site`、163 IMAP/SMTP 账户入口

未连接账户时显示演示数据；连接后使用 Cloudflare 真实 API。不要把真实邮箱密码或 163 授权码写入源码。

## Windows 开发环境

在 Windows 10/11 上安装：

1. Node.js 22 LTS 或更高版本
2. Rust stable（rustup）
3. Visual Studio 2022 Build Tools，勾选“使用 C++ 的桌面开发”
4. WebView2 Runtime

然后在项目根目录执行：

```powershell
pnpm install
pnpm tauri dev
```

## 生成 Windows 安装包

```powershell
pnpm tauri build
```

构建产物会出现在：

```text
src-tauri/target/release/bundle/
```

通常包括 NSIS 安装包（`.exe`）以及 MSI 安装包（如果本机工具链已安装）。

## 下一阶段

1. 对 `mail.kodao.site` 实际接口做登录、收件箱、邮件详情和附件适配。
2. ~~增加 163 IMAP/SMTP 适配器~~（已实现：`imap.163.com` 收信、`smtp.163.com` 发信）。
3. ~~将凭据保存到 Windows Credential Manager~~（已实现：Cloudflare 凭据与 163 授权码均经 Tauri 存入系统凭据库）。
4. 增加本地 SQLite 索引、增量同步和离线缓存。
5. 把验证码解析从演示数据切换为服务端字段优先、客户端规则兜底；163 侧解析正文中的验证码。

## Linux 沙箱限制

当前开发环境可以完成前端 TypeScript/Vite 构建，但没有 Rust 和 Windows MSVC 工具链，因此不能在这里直接产出 `.exe`。把项目复制到 Windows 后按上面的命令即可进行原生开发和打包。

## API 适配说明

Cloudflare 临时邮箱适配器已根据上游前端和文档实现以下调用：

| 功能 | 接口 |
|---|---|
| 公开配置 | `GET /open_api/settings` |
| 凭据登录 | `POST /open_api/credential_login` |
| 密码登录 | `POST /api/address_login` |
| 当前邮箱设置 | `GET /api/settings` |
| 邮件轻量列表 | `GET /api/mails?limit=20&offset=0` |
| 邮件解析列表 | `GET /api/parsed_mails?limit=20&offset=0` |
| 邮件详情 | `GET /api/mails/:id` |
| 已读状态 | `PATCH /api/mails/:id/read` |
| 删除邮件 | `DELETE /api/mails/:id` |
| 发信 | `POST /api/send_mail` |
| 创建地址 | `POST /api/new_address` |

请求会附带 `Authorization: Bearer <credential>`、`x-lang` 和本地设备指纹。错误会统一转为带 HTTP 状态码的 `CloudflareApiError`。

163 邮箱不会从 React WebView 直接连接 IMAP/SMTP。它将通过 Tauri Rust 后端接入：协议层可参考 [`async-imap`](https://github.com/chatmail/async-imap)，统一消息模型可参考 [`io-email`](https://github.com/pimalaya/io-email)。授权码应保存在 Windows Credential Manager，不能放进普通前端存储。

## 参考项目与文档

- [`cloudflare_temp_email`](https://github.com/dreamhunter2333/cloudflare_temp_email)：实际 Cloudflare 临时邮箱 API 和邮件解析基础设施。
- [`async-imap`](https://github.com/chatmail/async-imap)：Rust 异步 IMAP 协议库，支持列出、搜索、拉取和监听邮箱变化。
- [`io-email`](https://github.com/pimalaya/io-email)：统一 IMAP/JMAP/SMTP 等后端的 Rust 邮箱模型；当前项目暂不直接锁定该库，以减少早期依赖风险。
- [Tauri GitHub Actions 官方文档](https://v2.tauri.app/distribute/pipelines/github/)：Windows runner、Rust toolchain 和 `tauri-action` 发布流程。

## GitHub 发布

项目包含 `.github/workflows/release.yml`。推送 `v*` 标签或手动运行工作流后，GitHub Actions 会在 Windows runner 上生成原生安装包，并创建草稿 Release。正式发布前应补充 Windows 代码签名证书，避免 SmartScreen 警告。

### 当前实例地址核验

通过检查 `mail.kodao.site` 当前部署的前端 bundle，确认它把 REST API 基地址配置为 `https://email.kodao.site`；`https://mail.kodao.site` 是前端页面地址，直接请求其 `/open_api/settings` 会返回 HTML。因此客户端默认使用 `https://email.kodao.site`，但设置页仍允许修改，以兼容未来迁移或自部署实例。

## 基于 tempemail 源码的二次核对

客户端已按本地 `cloudflare_temp_email` 源码修正：邮件详情实际使用 `/api/mail/:mail_id`，解析邮件使用 `/api/parsed_mails` 与 `/api/parsed_mail/:mail_id`，发信使用 `/api/send_mail`，而不是早期假设的 `/api/mails/:id`、`/api/send`。连接成功后，收件箱优先读取服务端解析字段 `sender`、`subject`、`text`、`html` 和 `attachments`，本地验证码解析只作为兜底。

另外补齐客户端 API 方法：清空收件箱、删除邮箱地址、发件箱操作和分页 offset。上游的 S3 附件签名接口、自动回复和 Webhook 已记录在 `docs-research.md`，后续可根据部署实例是否启用对应功能再接入，避免对未开启的 Worker 功能产生错误请求。

## Windows 客户端当前可用功能

- 连接 `https://email.kodao.site` 并保存凭据到 Windows Credential Manager。
- 使用上游 `/api/parsed_mails` 加载服务端解析后的收件箱列表。
- 点击邮件按需加载 `/api/parsed_mail/:id`，减少首次打开的网络请求和正文传输。
- 刷新收件箱、自动标记已读、删除当前邮件。
- 优先使用服务端解析字段，客户端本地识别验证码并提供复制。
- 通过 `/api/send_mail` 发送纯文本邮件。
- 阅读区上一封、下一封、删除、标记未读、星标和更多操作按钮均已接入交互；星标目前保存在当前客户端会话中，上游暂未提供星标字段。
- **163 邮箱（原生 IMAP/SMTP）**：在设置里填入 163 邮箱和客户端授权码后即可连接，通过 `imap.163.com` 收信、`smtp.163.com` 发信；支持列表、按需读取正文、标记已读/未读、删除、发送。授权码只保存到 Windows Credential Manager。

前端验证命令为 `pnpm build`。Windows 原生 Rust 检查应在安装 Rust、Windows SDK 和 WebView2 的 Windows runner 上执行；GitHub Actions 工作流会在 Windows 环境中完成打包验证。

## 第二轮体验优化

收件箱现在支持全部、未读、带附件和验证码四种筛选，并支持 `Ctrl+K` 快速聚焦搜索框。API 请求使用 20 秒超时控制，能识别 Worker 返回的 `message` 或 `error` 字段；邮件正文在 React 中以文本方式展示，不直接注入远程 HTML，降低恶意邮件脚本执行风险。

## 轻量化优化

收件箱列表默认使用轻量的 `/api/mails` 数据，只加载发件人、主题、时间和未读状态；用户打开邮件时才请求 `/api/parsed_mail/:id` 获取正文。列表按每页 20 封分页，并保留最近 30 封已打开邮件的内存缓存，避免重复请求但不产生长期磁盘缓存。搜索使用 React 延迟值，减少连续输入时的重复过滤。界面移除远程 Google Fonts，改用 Windows 系统字体，降低启动时的网络请求和内存占用。

## GitHub 项目复用判断

`qsl`（Apache-2.0）适合参考 Rust 邮箱核心、IMAP IDLE、SQLite FTS、HTML 清洗和 OS keychain；`tutabridge`（GPL-3.0）适合参考同步器、离线加密缓存和本地 IMAP/SMTP bridge，但不能直接复制 GPL 代码到本项目；`2fhey`（CC0-1.0）适合参考多语言验证码规则。详细核对记录见 `docs-research.md`。

## UI 与 Cloudflare 辅助后端

本轮 UI 优化恢复并完善了完整布局样式，增加了更清晰的空结果页面、验证码导航动态计数、同步状态动画、操作结果 Toast、连接状态展示和更明确的凭据提示。本项目不再部署额外的 Cloudflare 辅助网关，AI 分析改为调用本机 OpenAI 兼容服务。

Cloudflare 仅继续作为临时邮箱的收件服务；不会为 AI 分析上传邮件内容，也不会部署额外云端 AI。阅读邮件时点击“本地 AI 分析”，客户端会将当前邮件发送到 `http://localhost:8000/v1/chat/completions` 或设置页中配置的 OpenAI 兼容地址。

GitHub 参考项目及许可证、Stars、架构对比见 `docs-research.md`。推荐继续以 `cloudflare_temp_email` 为主后端，参考 `email-explorer` 的 Cloudflare Durable Objects/R2/D1 组织方式，参考 `qsl` 的 Windows 本地优先和安全渲染设计，但不直接复制其代码。

## 本地 AI 邮件分析

CloudMail 支持本机 OpenAI 兼容接口，默认配置：

```text
接口：http://localhost:8000/v1
模型：Qwen3.5-9B-AWQ

```

启动本地模型服务后，在邮件阅读区点击“本地 AI 分析”，助手会用简体中文给出邮件摘要、验证码/关键链接、风险判断和建议操作。邮件内容只发送到本机地址，不发送到 Cloudflare 或 OpenAI 云端。

接口兼容以下请求形式：

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen3.5-9B-AWQ","messages":[{"role":"user","content":"你好"}],"temperature":0.2,"max_tokens":512,"stream":false}'
```

本地 AI 地址和模型可以在“设置 → 本地 AI 分析”中修改，并保存在当前客户端本地浏览器存储中。

## 手机网页 / PWA

CloudMail 现在采用响应式手机网页方案，不单独维护 Expo 原生端。手机浏览器打开网页后可以直接使用收件箱、验证码筛选、邮件详情、复制验证码和本地 AI 分析；窄屏下邮件详情会切换为全屏页面，点击返回按钮回到列表。页面已加入 PWA manifest，可通过手机浏览器“添加到主屏幕”。

## AI 默认输出格式

本地 AI 现在默认输出固定的中文字段：`摘要`、`验证码`、`关键链接`、`风险等级`、`风险依据`、`建议`、`置信度`。客户端会把这些字段渲染成独立卡片，而不是把模型原始长文本直接堆在正文下方。

## Cloudflare 云同步

仓库新增 `cloudflare-sync/` Worker + D1 同步骨架。它只同步账户引用、邮件 ID、已读状态、星标状态和可选的结构化 AI 结果，不上传邮箱 JWT、163 授权码、原始正文或附件。手机网页和 Windows 客户端可以使用同一个 Worker 地址和同步令牌。

云同步是可选的，设置页中手动填写 Worker 地址后，点击“同步已读、星标和 AI 结果”。同步令牌只保存在当前浏览器会话；生产环境建议改为每个用户独立的短期令牌，不要使用全局固定令牌。

## 原生 Windows 与网易邮箱增强

Windows 版本继续作为主力原生客户端，使用 Tauri 2 + Rust。163 邮箱使用 `imap.163.com:993` 收信和 `smtp.163.com:465` 发信，必须在网易网页版开启 IMAP/SMTP，并使用客户端授权码而不是网页登录密码。当前支持 163 收件箱刷新、按需读取正文、自动标记已读、手动标记未读、删除、纯文本发信和服务端搜索。

在 163 邮箱账户下，搜索框输入关键词并按 Enter 会调用 IMAP `OR SUBJECT / FROM` 服务端搜索，适用于不在当前已加载列表中的历史邮件。若遇到 `Unsafe Login`，客户端现在会给出针对网易协议设置的诊断提示。网易服务端可能要求客户端身份声明；项目已记录该兼容性限制，后续可升级到支持 RFC 2971 ID 扩展的 IMAP 实现。

本轮检索参考了 [async-imap](https://github.com/chatmail/async-imap)、[io-email](https://github.com/pimalaya/io-email) 和 [LobsterAI IMAP/SMTP 文档](https://github.com/netease-youdao/lobsterai/blob/main/SKILLs/imap-smtp-email/SKILL.md)，没有复制 GPL 代码。

## 云端 AI 与 OpenAI 兼容接口

AI 邮件分析现在支持本地和云端两种模式，统一使用 OpenAI Chat Completions 格式。设置页提供快速预设：

- 本地 Qwen：`http://localhost:8000/v1` / `Qwen3.5-9B-AWQ`
- 智谱 GLM：`https://open.bigmodel.cn/api/paas/v4` / `glm-5.3`
- OpenAI：`https://api.openai.com/v1` / `gpt-4o-mini`

也可以手动填写其他兼容 `/chat/completions` 的服务地址和模型名称。云端 API Key 通过 Windows Credential Manager 保存，不写入源码、localStorage 或日志；本地模型可以不填写 API Key。使用云端模型时，邮件正文会发送给对应的第三方模型服务，请根据邮件敏感程度选择本地模型或可信云端服务。
