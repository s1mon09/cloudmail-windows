# CloudMail Cloudflare Gateway

这是一个**可选**的 Cloudflare Worker 辅助网关，不替换现有 `cloudflare_temp_email` 服务。它只负责统一入口、CORS、健康检查和上游转发。

## 设计边界

- 默认上游是 `https://email.kodao.site`。
- 不保存邮箱凭据、JWT、邮件正文或附件。
- 不启用缓存，避免验证码和私人邮件被边缘缓存。
- 可通过 `GATEWAY_TOKEN` 增加网关级访问保护。
- 邮箱级 JWT 仍由上游 `cloudflare_temp_email` 处理。

## 部署

```bash
cp wrangler.toml.example wrangler.toml
npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

部署后，把 Windows 客户端的 API 地址改成 Worker URL。`/health` 和 `/open_api/settings` 可用于连接诊断；其余路径会原样转发到上游。

## 注意事项

Cloudflare Email Routing 负责接收邮件，Cloudflare Email Sending 负责发信；这个网关不等于 IMAP/SMTP 服务。如果要接入 163 邮箱，仍应在 Windows 客户端内使用 IMAP/SMTP，并将授权码放在 Windows Credential Manager。
