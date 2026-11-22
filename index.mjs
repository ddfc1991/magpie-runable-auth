// Magpie provider plugin: Runable (Claude models via Runable session token)
// Runable's /api/chat/text is a custom SSE endpoint (NOT OpenAI-compatible).
// This plugin translates OpenAI chat completions <-> Runable SSE in its fetch.
import { randomUUID } from "node:crypto";

const PROVIDER = "runable";
const BASE = "https://api.runable.com";
const CHAT_URL = `${BASE}/api/chat/text`;
const SDK = "@ai-sdk/openai-compatible";

// Model id on Runable -> display name. Keep in sync with runable's catalog.
const MODELS = {
  "anthropic/claude-sonnet-5.5": { name: "Claude Sonnet 5.5", limit: { context: 200000, output: 32000 } },
  "anthropic/claude-sonnet-5.0": { name: "Claude Sonnet 5", limit: { context: 200000, output: 32000 } },
  "anthropic/claude-haiku-5.5": { name: "Claude Haiku 5.5", limit: { context: 200000, output: 32000 } },
};

function textContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

function toolBrief(tools) {
  const rows = [];
  for (const t of tools || []) {
    if (!t || typeof t !== "object") continue;
    const fn = t.function || {};
    const name = fn.name || "?";
    const desc = (fn.description || "").trim();
    const params = JSON.stringify(fn.parameters || {});
    rows.push(`- ${name}: ${desc}  params: ${params}`);
  }
  return rows.length ? rows.join("\n") : "(none)";
}

const TOOL_INSTRUCTION = `[system]
You have tools available. If the user's request requires using a tool, respond with ONLY a single JSON object (no markdown fences, no extra text, no commentary) of the exact shape:
{"tool_calls":[{"id":"call_<random>","type":"function","function":{"name":"<tool>","arguments":"<JSON string of arguments>"}}]}
The arguments field MUST be a JSON-encoded string. Choose the right tool, fill in real argument values, and you may emit several calls at once. If no tool is needed, answer normally with plain text.
Available tools:
{tools}`;

function prompt(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("messages must be a non-empty array");
  if (messages.length === 1 && messages[0].role === "user") return textContent(messages[0].content);
  const rows = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") throw new Error("Invalid message");
    const role = m.role || "user";
    const t = textContent(m.content);
    if (role === "tool") {
      rows.push(`[tool result for call ${m.tool_call_id || "?"}]\n${t}`);
    } else if (role === "assistant" && m.tool_calls) {
      const calls = (m.tool_calls || []).map((tc) => {
        const fn = tc.function || {};
        return `${fn.name || ""}(${String(fn.arguments || "")})`;
      });
      rows.push(`[assistant]\n${t ? t + " " : ""}[model called tools: ${calls.join("; ")}]`);
    } else {
      if (t) rows.push(`[${role}]\n${t}`);
    }
  }
  if (!rows.length) throw new Error("No text message supplied");
  return rows.join("\n\n");
}

function parseToolCalls(text) {
  if (!text) return null;
  let t = String(text).trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) t = m[1].trim();
  let d = null;
  try { d = JSON.parse(t); } catch { const s = t.indexOf("{"); if (s >= 0) { try { d = JSON.parse(t.slice(s)); } catch {} } }
  if (!d || typeof d !== "object") return null;
  const tcs = d.tool_calls;
  if (!Array.isArray(tcs) || !tcs.length) return null;
  const out = [];
  for (const tc of tcs) {
    if (!tc || typeof tc !== "object") continue;
    const fn = tc.function || {};
    const name = fn.name || "";
    let args = fn.arguments;
    if (typeof args !== "string") args = JSON.stringify(args);
    if (!name) continue;
    out.push({ id: tc.id || `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name, arguments: args } });
  }
  return out.length ? out : null;
}

// Convert a Runable SSE event stream into an OpenAI chat.completion.chunk stream.
function runableToOpenAIStream(body, upstreamResp, signal) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
  const model = (body.model || "").split("@")[0] || "runable";
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const reader = upstreamResp.body.getReader();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finished = false;

  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  return new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(encoder.encode(s));
      try {
        for (;;) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (raw === "[DONE]") { finished = true; continue; }
            let e;
            try { e = JSON.parse(raw); } catch { continue; }
            const type = e.type;
            if (type === "text-delta") {
              const delta = e.delta ?? e.textDelta ?? "";
              if (delta) { content += delta; push(chunk({ content: delta })); }
            } else if (type === "reasoning-delta") {
              const delta = e.delta ?? "";
              if (delta) { reasoning += delta; push(chunk({ reasoning_content: delta })); }
            } else if (type === "error") {
              push(chunk({}, "stop"));
              push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
              push("data: [DONE]\n\n");
              controller.close();
              return;
            } else if (type === "finish" || type === "abort") {
              finished = true;
            }
          }
        }
        // final: usage + finish + tool_calls recovery
        const toolCalls = parseToolCalls(content);
        if (toolCalls) {
          push(chunk({ tool_calls: toolCalls.map((tc, i) => ({ index: i, ...tc })) }));
        }
        push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`);
        push("data: [DONE]\n\n");
        controller.close();
      } catch (err) {
        try { controller.error(err); } catch {}
      }
    },
  });
}

export async function RunablePlugin() {
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "Runable",
        npm: SDK,
        api: BASE,
        models: Object.fromEntries(
          Object.entries(MODELS).map(([id, m]) => [
            id,
            { name: m.name, limit: m.limit, reasoning: true, tool_call: true, modalities: { input: ["text"], output: ["text"] }, cost: { input: 0, output: 0 } },
          ])
        ),
      };
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "Runable session token",
          placeholder: "32-char session token from creds.json",
          prompts: [
            { type: "password", key: "token", message: "Session token", placeholder: "Runable session token", validate: (v) => (v && v.trim() ? undefined : "Token required") },
          ],
          async authorize(input, inputs) {
            const obj = input && typeof input === "object" && !Array.isArray(input) ? input : inputs || {};
            const token = ((typeof input === "string" && input.trim()) || obj.token || obj.key || "").trim();
            if (!token) return { type: "failed", error: "Token required" };
            return { type: "success", key: token };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        const token = auth.key ?? auth.methods?.[0]?.key ?? "";
        if (!token) return {};
        return {
          baseURL: BASE,
          apiKey: token,
          async fetch(input, init) {
            const req = new Request(input, init);
            let bodyText = typeof init?.body === "string" ? init.body : null;
            if (!bodyText && req.body) bodyText = await req.text();
            const body = bodyText ? JSON.parse(bodyText) : {};
            const model = (body.model || "").split("@")[0] || "anthropic/claude-sonnet-5.5";
            if (!MODELS[model]) {
              return new Response(JSON.stringify({ error: { message: `Model ${model} not enabled on this bridge`, type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
            }
            const messages = body.messages || [];
            let content = prompt(messages);
            const tools = body.tools || body.functions || null;
            // Runable 上游对单条 message 文本有约 8000 字符的硬限制,超过即返回 HTTP 400。
            // 把所有历史拼成一条巨型文本必然超限——按安全上限截断,保留工具指令(完整)+最近对话。
            const MAX_CHARS = 7800;
            const instr = tools ? TOOL_INSTRUCTION.replace("{tools}", toolBrief(tools)) + "\n\n" : "";
            if (instr.length + content.length > MAX_CHARS) {
              const budget = Math.max(200, MAX_CHARS - instr.length);
              const head = Math.min(400, Math.floor(budget / 3));
              const tail = Math.max(120, budget - head - 60);
              if (content.length > head + tail + 60) {
                const dropped = content.length - head - tail;
                content = content.slice(0, head) + `\n...[truncated ${dropped} chars; oldest context dropped to fit Runable limit]...\n` + content.slice(-tail);
              } else {
                content = content.slice(0, budget);
              }
            }
            content = instr + content;

            const payload = {
              id: randomUUID(),
              trigger: "submit-message",
              modelId: model,
              message: { id: randomUUID(), role: "user", parts: [{ type: "text", text: content }] },
            };
            const headers = {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              Origin: "https://runable.com",
              Referer: "https://runable.com/",
              "User-Agent": "Mozilla/5.0 (Linux; Android 14) MagpieRunable/0.1.0",
              "x-runable-device": "dweb/a69d4f72ddd711c660237adaf5c76287ac5473f5",
            };
            const upstream = await fetch(CHAT_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: init?.signal ?? req.signal });
            if (!upstream.ok) {
              const msg = { 401: "Runable session expired", 402: "Runable credits exhausted", 403: "Runable denied this request", 429: "Runable rate limited this request" }[upstream.status] || `Runable returned HTTP ${upstream.status}`;
              return new Response(JSON.stringify({ error: { message: msg, type: "upstream_error" } }), { status: upstream.status, headers: { "content-type": "application/json" } });
            }
            return new Response(runableToOpenAIStream(body, upstream, init?.signal), { status: 200, headers: { "content-type": "text/event-stream" } });
          },
        };
      },
      async usage(getAuth) {
        const auth = await getAuth?.();
        if (!auth) return { plan: "Runable", windows: [] };
        return { plan: "Runable (session)", windows: [] };
      },
    },
  };
}

export default RunablePlugin;
