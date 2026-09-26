# CloudMail Cloudflare Sync

这是一个可选的 Cloudflare Worker + D1 云同步服务。它只同步账户引用、邮件 ID、已读状态、星标状态和结构化 AI 结果，不接收邮箱 JWT、163 授权码、邮件正文或附件。

## 部署

1. 创建 D1 数据库并执行 `schema.sql`。
2. 在 `wrangler.toml` 中绑定 D1 数据库。
3. 使用 `wrangler secret put SYNC_TOKEN` 设置随机同步令牌，不要写入仓库。
4. 部署 Worker。

示例配置：

```toml
name = "cloudmail-sync"
main = "src/index.ts"
compatibility_date = "2026-09-01"

[[d1_databases]]
binding = "DB"
database_name = "cloudmail-sync"
database_id = "replace-with-your-d1-id"
```

## API

- `GET /health`：健康检查。
- `GET /v1/sync/pull?account_ref=...`：拉取当前账户的同步状态。
- `POST /v1/sync/push`：批量上传状态和结构化 AI 结果。

所有同步 API 都需要：

```text
Authorization: Bearer <SYNC_TOKEN>
```

客户端默认不上传正文；如果用户开启 AI 结果同步，也只上传结构化结果，并限制为 12,000 字符。生产部署前应把 `SYNC_TOKEN` 替换为每个用户独立的短期令牌，而不是全局固定令牌。
