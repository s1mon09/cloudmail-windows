# CloudMail 适配研究记录

## 上游 cloudflare_temp_email

来源：<https://github.com/dreamhunter2333/cloudflare_temp_email>，本地源码 `/home/ubuntu/cloudflare-temp-email-research`，当前浅克隆提交 `4dda1eb`。

Worker 路由来自 `worker/src/mails_api/index.ts`：

- `GET /open_api/settings`
- `POST /open_api/credential_login`
- `POST /api/address_login`
- `GET /api/settings`
- `GET /api/mails?limit=&offset=`
- `GET /api/mail/:mail_id`（注意是单数 `mail`）
- `GET /api/parsed_mails?limit=&offset=`
- `GET /api/parsed_mail/:mail_id`
- `PATCH /api/mails/:id/read`
- `DELETE /api/mails/:id`
- `POST /api/new_address`
- `DELETE /api/delete_address`
- `DELETE /api/clear_inbox`
- `DELETE /api/clear_sent_items`
- `GET/POST /api/auto_reply`
- `GET/POST /api/webhook/settings`
- `POST /api/webhook/test`
- S3 附件相关 `GET /api/attachment/list`、`POST /api/attachment/delete`、`POST /api/attachment/put_url`、`POST /api/attachment/get_url`

解析邮件接口会返回 `sender`、`subject`、`text`、`html`、`attachments`，每个附件包含 `filename`、`mimeType`、`disposition`、`size`。验证码提取在 Worker 内使用规则引擎，支持多语言、全角字符、分组数字、字母数字编码，并过滤日期、电话号码、金额、URL 和邮箱地址。

代理配置来自 `SMTP_IMAP_PROXY_CONFIG`，结构为：

```json
{
  "smtp": { "host": "smtp.example.com", "port": 8025, "starttls": true },
  "imap": { "host": "imap.example.com", "port": 11143, "starttls": true }
}
```

现场核验：`https://mail.kodao.site` 返回前端 HTML；其 bundle 内配置的实际 API 基地址是 `https://email.kodao.site`。`GET https://email.kodao.site/open_api/settings` 返回 JSON 200。

## GitHub 参考项目

### QSL

来源：<https://github.com/johnathonfox/qsl>。Apache-2.0，Tauri 2 + Rust，Windows 可编译但尚未充分运行验证。可借鉴：本地优先、IMAP IDLE、增量同步、SQLite/FTS、HTML `ammonia` 清洗、OS keychain、统一 MailBackend。项目状态为 experimental，不能直接整仓库复用。

### TutaBridge

来源：<https://github.com/spartanz51/tutabridge>。GPL-3.0，Rust + Tauri，Windows 已提供安装包。可借鉴：本地 IMAP/SMTP bridge、同步器与 store 解耦、加密缓存、离线全文搜索、备份为 `.eml`、Windows 打包。但 GPL-3.0 与 CloudMail 当前 MIT/自有代码组合存在许可证约束，不能直接复制代码，适合借鉴架构。

### async-imap

来源：<https://github.com/chatmail/async-imap>。Apache-2.0/MIT 双许可证，提供 Rust 异步 IMAP 的登录、列表、搜索、拉取和邮箱变化监听，适合实现 163 Provider。

### io-email

来源：<https://github.com/pimalaya/io-email>。Apache-2.0/MIT，统一 IMAP、JMAP、Gmail、Microsoft Graph、Maildir 和 SMTP 的消息模型；项目较新，适合参考统一接口，不在第一版直接锁定。

### 2FHey

来源：<https://github.com/SoFriendly/2fhey>。CC0-1.0，专注验证码识别、一键复制、通知和多语言规则，可借鉴检测策略。上游 `cloudflare_temp_email` 已有更完整的 Worker 验证码规则，因此客户端应优先使用服务端字段，客户端只做兜底。

## 结论

CloudMail 应直接根据本地 `cloudflare_temp_email` 源码修正 API 客户端，尤其是 `parsed_mail` 的单数路径与附件字段；163 IMAP/SMTP 应放在 Tauri Rust 后端，凭据写入 Windows Credential Manager，前端只接收统一后的邮件模型。

## 2026-09-24 UI 与 Cloudflare 后端检索

### GitHub 参考项目

- [G4brym/email-explorer](https://github.com/G4brym/email-explorer)：MIT，约 163 stars。完整 Cloudflare Workers 邮箱平台，使用 Workers、Durable Objects、R2、D1、Email Routing 和 Email Sending，具备认证、RBAC、文件夹、附件、全文搜索、回复/转发等能力。适合参考 Cloudflare 后端架构，不建议直接替换当前 tempemail 数据模型。
- [dreamhunter2333/cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email)：MIT，约 11.8k stars、692 commits。当前项目已基于它适配，包含 D1、Workers、Pages、Rust WASM 邮件解析、R2/S3 附件、SMTP/IMAP proxy、验证码识别、Webhook 和 OAuth/Passkey 等，继续作为主邮箱后端最稳妥。
- [johnathonfox/qsl](https://github.com/johnathonfox/qsl)：Apache-2.0，Rust/Tauri 2 本地优先邮箱客户端，参考价值包括 OS keychain、HTML 清洗、命令搜索、增量同步和本地全文搜索；但仓库明确表示 Windows 运行时尚未验证、维护承诺有限，不直接复制代码。

### 选型结论

CloudMail 保留现有 `cloudflare_temp_email` 作为临时邮箱服务，但不再部署额外 Cloudflare 网关或云端 AI。邮件分析使用本机 OpenAI 兼容接口，默认 `http://localhost:8000/v1`，邮件正文不会上传到云端 AI 服务。

Cloudflare 官方文档确认 Email Routing 可将来信交给 Worker，Email Sending 可通过 Worker `EMAIL` binding、REST API 或 authenticated SMTP 发信；这些功能不提供对 163 邮箱的 IMAP 访问，因此 163 仍需客户端内置 `async-imap`/`lettre` 方案。
