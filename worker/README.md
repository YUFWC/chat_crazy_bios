# GIST GPT：Cloudflare Worker API 网关

Worker 处理访客验证、短时限流和每日配额，并使用独立的 CodeArts 凭据直接访问官方 HTTPS API。刷新后的临时凭据由单个 Durable Object 保存；服务器上原有的另一组 CodeArts 凭据继续由服务器管理。图片请求由 Worker 调用 SenseNova 的文字生图接口。

CodeArts 福利模型需要该账号先领取模型权益。若推理接口以 HTTP 200 返回 `error_code: 4004`、`error_msg: benefit not found`，说明账号尚未领取权益；`/api/status` 只检查 Worker 配置，不能证明上游账号有可用额度。GLM 5.3 Flash 不接受 `enable_thinking: false`，Worker 在快速模式下仍会为它启用思考。

## 接口与额度

- `GET /api/status`：返回配置状态、可选模型和额度，不返回密钥。
- `POST /api/chat`：接受文字消息和一次性 Turnstile token，允许 `deepseek-v4.1-flash`、`glm-5.3-flash`。
- `POST /api/images`：接受文字提示和一次性 Turnstile token，只生成图片，不修改图片。
- 每访客 IP 每 UTC 日 100 次，全站每 UTC 日 80,000 次，全站每日 200,000,000 tokens，每 IP 每分钟 12 次。图片另设每访客每日 10 次、全站每日 100 次。
- `快速/推理` 对 DeepSeek 对应上游 `enable_thinking: false/true`；GLM 5.3 Flash 始终启用思考。单次聊天输出上限 4096 tokens。

SQLite Durable Object 原子预留并结算额度。上游失败或未返回可靠 usage 时，保留预留的次数和 token 数。本站额度不等于 CodeArts 账单硬限额。

这些是应用层上限，不代表 Cloudflare 免费套餐可承载同等数量的成功聊天。每次成功聊天约触发 3 次 Durable Object 请求、5 行 SQLite 写入；按免费套餐每日 100,000 次 Durable Object 请求及 100,000 行写入估算，SQLite 写入会在约 20,000 次成功聊天后先触顶。要让 80,000 次/日成为实际可用容量，须改造配额存储或使用付费套餐。

## 配置

```powershell
npm ci
npm test
npm run test:runtime
```

在 `wrangler.jsonc` 设置实际网页的 `ALLOWED_ORIGIN`、`ALLOWED_HOSTNAME`、可选的 `ALLOWED_ORIGIN_ALT`、Turnstile action 和限额。Turnstile 小组件须登记每个允许的主机名。按 Cloudflare 账号分配 `ratelimits[0].namespace_id`。

设置 Worker secrets：

```powershell
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put QUOTA_SALT
npx wrangler secret put CODEARTS_CREDENTIAL_JSON
npx wrangler secret put SENSENOVA_API_KEYS
```

`QUOTA_SALT` 至少 16 字符。`CODEARTS_CREDENTIAL_JSON` 是单行 JSON，包含本地凭据中的 `access_key`、`secret_key`、`security_token`、`expired`、`refresh_token`、`code_verifier`、`dpop_private_key`、`dpop_public_key`、`user_id`。此凭据应只由 Worker 使用；本地代理的同一凭据文件必须移出活动目录，避免两个进程竞争轮换 refresh token。`SENSENOVA_API_KEYS` 是去重后的 Key JSON 数组，Worker 按访客分配，遇到明确的 401、403 或 429 时尝试下一条 Key。密钥只保存在部署平台的 Secret 中，不进入 Git。

网页 `site/public-config.js` 只填 Worker 的公开 HTTPS 地址和 Turnstile sitekey。网站实际聊天和生图需要 Cloudflare Pages 与 Worker 部署、Turnstile 和对应 secrets。GitHub 仓库只保存源码。

聊天请求示例：

```json
{"turnstileToken":"每次发送重新获取的 token","pace":"fast","model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}
```

图片请求示例：

```json
{"prompt":"一只黄色小鸭","turnstileToken":"本次访客验证 token"}
```

图片固定为单张 1024×1024 PNG，保留官方水印；模型为 `sensenova-u1.5-lite`。`GET /api/status` 的 `ready` 仅表示配置完整，不代表账号或上游实时健康。
