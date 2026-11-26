# magpie-runable-auth

Magpie provider 插件 —— 用 runable.com 的**网页会话 token**接入 Runable 的 Claude 模型。
支持**多账号轮询**：一个号过期/欠费/限流，自动换下一个号继续。

## 为什么需要翻译层

Runable 不是 OpenAI 兼容接口，它只有一个自定义 SSE 端点：

```
POST https://api.runable.com/api/chat/text
Accept: text/event-stream
Authorization: Bearer <session token>
{
  "id": "<uuid>", "trigger": "submit-message", "modelId": "anthropic/claude-sonnet-5.5",
  "message": { "id": "<uuid>", "role": "user", "parts": [{ "type": "text", "text": "..." }] }
}
```

返回事件流：`text-delta` / `reasoning-delta` / `finish` / `error`。

插件的 `auth.loader` 返回自定义 `fetch`，把 OpenAI chat-completions 双向翻译成这个协议：
请求侧压平成单条文本，响应侧把 SSE 事件转回 `chat.completion.chunk`。

## 模型（只用免费档）

| 模型 ID | 名称 | 费用 |
|---|---|---|
| `anthropic/claude-sonnet-5.5` | Claude Sonnet 5.5 | 免费 |
| `anthropic/claude-sonnet-5.0` | Claude Sonnet 5.0 | 免费 |
| `anthropic/claude-haiku-5.5` | Claude Haiku 5.5 | 免费 |

**Opus / Fable 是付费的，故意没有收录**——写进配置就会被请求，白跑 credits。
请求非免费模型会直接 400 拒绝。

网关里调用时 id 形如 `runable/anthropic/claude-sonnet-5.5`（`runable/` 前缀会自动剥掉）。

## 多号轮询机制

token 输入框支持一次粘**多个** token，用换行 / 空格 / 逗号分隔：

```
tok_账号1...
tok_账号2...
tok_账号3...
```

- 请求按轮转（round-robin）挑一个健康号
- 上游返回 **401**（会话过期）→ 该号停用 6 小时，立刻换下一个号重试
- **402**（额度用尽）→ 停用 1 小时
- **429**（限流）→ 停用 60 秒
- **403**（被拒）→ 停用 10 分钟
- 全部号都不可用时，报错里会列出「试了几个号 / 哪些在停用中」，直接看出该补哪个号

同一个请求最多把健康号全试一遍，所以 5 个号里挂 1 个，体验上无感。

## 安装

插件页底部输入框粘贴：

```
github:ddfc1991/magpie-runable-auth
```

> 仓库是 private。Magpie 拉不到 private 仓库时，改用本地路径安装：
> ```
> path:/sdcard/Download/magpie-runable-auth
> ```
> 或把目录拷进 Magpie 的插件目录。

装好后：供应商 → `+ 添加供应商` → **来自插件** → Runable → 粘贴 token（多号就多行）→ 下一步 → 保存。

## 拿 token

1. 浏览器登录 https://runable.com（Google / Apple / Microsoft）
2. 开发者工具 → Application → Cookies，或任一 `api.runable.com` 请求的 `Authorization` 头
3. 取 session token（形如 `iHCofy…` 的长串）

每个号重复一次，全部粘进同一个输入框即可。

## 实测

真 token 端到端（非 mock）：

```
流式   anthropic/claude-haiku-5.5   → 200, "插件链路正常", 以 [DONE] 收尾
非流式 anthropic/claude-sonnet-5.5  → 200, "收到", finish_reason=stop
```

单元测试 30 项（mock 上游，不需要真 token）：

```bash
node --check index.mjs
node test.mjs
```

## 已知限制

- **多轮被压平**：Runable 只收单条文本，历史拼成 `[system]…[user]…[assistant]…` 文本块
- **约 8000 字符硬上限**：超出会被 Runable 直接 400。插件保留头部 400 字 + 最新尾部，中间插截断标记（实测 7799 字符安全）
- **不读图**：文本接口不收图片，非文本 part 被丢弃
- **工具调用是模拟的**：Runable 无原生 function calling，靠提示词约定 + 解析模型输出的 JSON，成功率依赖模型
- token 等同账号权限，别外泄，commit 前先自查

## License

MIT
