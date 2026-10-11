# GIST GPT

仓库包含静态网页和 Cloudflare Worker：

- `site/`：GitHub Pages 网页。
- `worker/`：聊天、生图、Turnstile 验证与每日额度 API。

网页发布到 GitHub Pages。Cloudflare Workers 的 Git 集成使用同一仓库，**Root directory 设为 `worker`**，配置文件为 `worker/wrangler.jsonc`。Worker 需要单独配置以下 Secrets：

| Secret | 用途 |
| --- | --- |
| `TURNSTILE_SECRET` | 验证访客 |
| `QUOTA_SALT` | 至少 16 字符的随机盐 |
| `CODEARTS_CREDENTIAL_JSON` | 独立 CodeArts 临时凭据与刷新字段 |
| `SENSENOVA_API_KEYS` | 两条不同的生图 Key，JSON 字符串数组 |

CodeArts 凭据由 Worker 的单个 Durable Object 刷新并保存。本地代理不可同时使用同一份 refresh token。生图 Key 去重后按访客分配，遇到 401、403、429 时切换另一条。真实密钥不在仓库中；GitHub 仓库 Secret 和 Cloudflare Worker Secret 是两套独立设置，Cloudflare 拉取源码时不会自动读取 GitHub Secret。

页面里的 `site/public-config.js` 需要填入上线后的 Worker HTTPS 地址和 Turnstile sitekey（sitekey 是公开值）。在这两项配置前，页面仅可使用本地聊天记录，无法实际聊天或生图。

Worker 的详细配置与测试见 [worker/README.md](worker/README.md)。
