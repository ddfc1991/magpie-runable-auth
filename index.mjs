// Magpie provider plugin: Runable (Claude free models via Runable web sessions)
//
// Runable's /api/chat/text is a custom SSE endpoint (NOT OpenAI-compatible).
// This plugin translates OpenAI chat completions <-> Runable SSE in its fetch,
// and rotates across MULTIPLE session tokens (multi-account) when one is
// expired / out of credits / rate limited.
import { randomUUID } from "node:crypto";

const PROVIDER = "runable";
const BASE = "https://api.runable.com";
const CHAT_URL = `${BASE}/api/chat/text`;
const SDK = "@ai-sdk/openai-compatible";

// Free-tier models only. Opus / Fable are paid on Runable and are excluded
// on purpose — everything here costs 0 credits.
const MODELS = {
  "anthropic/claude-sonnet-5.5": { name: "Claude Sonnet 5.5" },
  "anthropic/claude-sonnet-5.0": { name: "Claude Sonnet 5.0" },
  "anthropic/claude-haiku-5.5": { name: "Claude Haiku 5.5" },
};
const LIMIT = { context: 200000, output: 32000 };

/* ------------------------------------------------------------ token pool */

// Cooldowns: how long a token is benched after a given upstream status.
const BENCH_MS = { 401: 6 * 3600e3, 402: 3600e3, 403: 600e3, 429: 60e3 };

function parseTokens(raw) {
  if (!raw) return [];
  const list = String(raw)
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^Bearer\s+/i, ""))
    .filter((s) => s.length >= 8);
  return [...new Set(list)];
}

const POOL = {
  tokens: [],
  cursor: 0,
  bench: new Map(), // token -> { until, status }
  stats: new Map(), // token -> { ok, fail }

  load(raw) {
    const next = parseTokens(raw);
    if (next.join() !== this.tokens.join()) {
      this.tokens = next;
      this.cursor = 0;
      this.bench = new Map();
      this.stats = new Map(next.map((t) => [t, { ok: 0, fail: 0 }]));
    }
  },
  alive() {
    const now = Date.now();
    return this.tokens.filter((t) => {
      const b = this.bench.get(t);
      return !b || b.until <= now;
    });
  },
  pick() {
    const live = this.alive();
    if (!live.length) return null;
    const t = live[this.cursor % live.length];
    this.cursor = (this.cursor + 1) % Math.max(1, live.length);
    return t;
  },
  ok(token) {
    const s = this.stats.get(token) || { ok: 0, fail: 0 };
    s.ok++;
    this.stats.set(token, s);
  },
  fail(token, status) {
    const s = this.stats.get(token) || { ok: 0, fail: 0 };
    s.fail++;
    this.stats.set(token, s);
    const ms = BENCH_MS[status];
    if (ms) this.bench.set(token, { until: Date.now() + ms, status });
  },
  mask(t) {
    return t ? t.slice(0, 6) + "…" + t.slice(-4) + " (" + t.length + ")" : "?";
  },
  benchInfo() {
    const now = Date.now();
    const out = [];
    for (const [t, b] of this.bench) {
      if (b.until > now) out.push(`${this.mask(t)}=HTTP${b.status} ${Math.ceil((b.until - now) / 1000)}s`);
    }
    return out;
  },
};

/* ---------------------------------------------------------------- helpers */

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
  try {
    d = JSON.parse(t);
  } catch {
    const s = t.indexOf("{");
    if (s >= 0) {
      try {
        d = JSON.parse(t.slice(s));
      } catch {}
    }
  }
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
    out.push({ id: tc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 8)}`, type: "function", function: { name, arguments: args } });
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
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finished = false;

  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  return new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(encoder.encode(s));
      const close = () => {
        try {
          controller.close();
        } catch {}
      };
      try {
        for (;;) {
          if (signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (raw === "[DONE]") {
              finished = true;
              continue;
            }
            let e;
            try {
              e = JSON.parse(raw);
            } catch {
              continue;
            }
            const type = e.type;
            if (type === "text-delta") {
              const delta = e.delta ?? e.textDelta ?? "";
              if (delta) {
                content += delta;
                push(chunk({ content: delta }));
              }
            } else if (type === "reasoning-delta") {
              const delta = e.delta ?? "";
              if (delta) push(chunk({ reasoning_content: delta }));
            } else if (type === "error") {
              push(JSON.stringify({ error: { message: String(e.errorText || "Runable stream failed").slice(0, 300), type: "upstream_error" } }));
              break;
            } else if (type === "finish" || type === "abort") {
              finished = true;
            }
          }
        }
        if (!finished && content) {
          // stream ended without an explicit finish event — recover tool calls
        }
        const toolCalls = parseToolCalls(content);
        if (toolCalls) push(chunk({ tool_calls: toolCalls.map((tc, i) => ({ index: i, ...tc })) }));
        push(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }],
          })}\n\n`
        );
        push("data: [DONE]\n\n");
        close();
      } catch (err) {
        try {
          push(JSON.stringify({ error: { message: String(err && err.message || err).slice(0, 300), type: "upstream_error" } }));
          push("data: [DONE]\n\n");
        } catch {}
        close();
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
            {
              name: m.name,
              limit: LIMIT,
              reasoning: true,
              tool_call: true,
              modalities: { input: ["text"], output: ["text"] },
              cost: { input: 0, output: 0 },
            },
          ])
        ),
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "Runable session tokens",
          placeholder: "one or more session tokens, separated by spaces/newlines",
          prompts: [
            {
              type: "password",
              key: "token",
              message: "Runable session token(s) — 多号用换行/空格分隔",
              placeholder: "tok1 tok2 tok3 … (登录 runable.com 后从 cookie 取)",
              validate: (v) => (parseTokens(v).length ? undefined : "At least one token required"),
            },
          ],
          async authorize(input, inputs) {
            const obj = input && typeof input === "object" && !Array.isArray(input) ? input : inputs || {};
            const raw = (typeof input === "string" && input.trim()) || obj.token || obj.key || "";
            const tokens = parseTokens(raw);
            if (!tokens.length) return { type: "failed", error: "At least one token required" };
            // Multiple tokens are stored newline-joined under the single key.
            return { type: "success", key: tokens.join("\n") };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        const raw = auth.key ?? auth.methods?.[0]?.key ?? "";
        const tokens = parseTokens(raw);
        if (!tokens.length) return {};
        POOL.load(tokens.join(" "));

        async function runableFetch(input, init) {
          let bodyText = typeof init?.body === "string" ? init.body : null;
          if (!bodyText && init?.body && typeof init.body.text === "function") bodyText = await init.body.text();
          let body = {};
          try {
            body = bodyText ? JSON.parse(bodyText) : {};
          } catch {
            body = {};
          }

          const model = (body.model || "").split("@")[0].replace(/^runable\//, "") || "anthropic/claude-sonnet-5.5";
          if (!MODELS[model]) {
            return new Response(
              JSON.stringify({ error: { message: `Model ${model} is not a free Runable model`, type: "invalid_request_error" } }),
              { status: 400, headers: { "content-type": "application/json" } }
            );
          }

          // ---- build the flattened prompt (+ Runable's ~8000 char hard cap)
          const tools = body.tools || body.functions || null;
          let content;
          try {
            content = prompt(body.messages || []);
          } catch (e) {
            return new Response(JSON.stringify({ error: { message: String(e.message), type: "invalid_request_error" } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          const MAX_CHARS = 7800;
          const instr = tools ? TOOL_INSTRUCTION.replace("{tools}", toolBrief(tools)) + "\n\n" : "";
          if (instr.length + content.length > MAX_CHARS) {
            const budget = Math.max(200, MAX_CHARS - instr.length);
            // Reserve room for the truncation marker itself, otherwise the
            // final string overshoots the cap by the marker length.
            const mk = (n) => `\n...[truncated ${n} chars; oldest context dropped to fit Runable limit]...\n`;
            const reserve = mk(999999).length;
            const usable = Math.max(120, budget - reserve);
            const head = Math.min(400, Math.floor(usable / 3));
            const tail = Math.max(60, usable - head);
            const dropped = Math.max(0, content.length - head - tail);
            content = content.slice(0, head) + mk(dropped) + content.slice(-tail);
            if (content.length > budget) content = content.slice(0, budget);
          }
          content = instr + content;

          const payload = {
            id: randomUUID(),
            trigger: "submit-message",
            modelId: model,
            message: { id: randomUUID(), role: "user", parts: [{ type: "text", text: content }] },
          };

          // ---- try each healthy token in turn
          const attempts = Math.max(1, POOL.alive().length);
          let lastStatus = null;
          let lastMsg = "No Runable session available";
          const tried = [];

          for (let i = 0; i < attempts; i++) {
            const token = POOL.pick();
            if (!token) break;
            tried.push(POOL.mask(token));

            let upstream;
            try {
              upstream = await fetch(CHAT_URL, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                  Accept: "text/event-stream",
                  Origin: "https://runable.com",
                  Referer: "https://runable.com/",
                  "User-Agent": "Mozilla/5.0 (Linux; Android 14) MagpieRunable/1.0.0",
                  "x-runable-device": "dweb/a69d4f72ddd711c660237adaf5c76287ac5473f5",
                },
                body: JSON.stringify(payload),
                signal: init?.signal,
              });
            } catch (e) {
              lastStatus = 502;
              lastMsg = "Runable connection failed: " + String(e && e.message || e).slice(0, 200);
              continue;
            }

            if (upstream.ok) {
              POOL.ok(token);
              if (body.stream === false) {
                // Drain into a single completion for non-streaming clients.
                const raw = await upstream.text();
                let text = "";
                let reasoning = "";
                for (const line of raw.split("\n")) {
                  if (!line.startsWith("data:")) continue;
                  const s = line.slice(5).trim();
                  if (!s || s === "[DONE]") continue;
                  let e;
                  try {
                    e = JSON.parse(s);
                  } catch {
                    continue;
                  }
                  if (e.type === "text-delta") text += e.delta ?? e.textDelta ?? "";
                  else if (e.type === "reasoning-delta") reasoning += e.delta ?? "";
                }
                const message = { role: "assistant", content: text };
                if (reasoning) message.reasoning_content = reasoning;
                return new Response(
                  JSON.stringify({
                    id: `chatcmpl-${randomUUID().replace(/-/g, "")}`,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, message, finish_reason: "stop" }],
                  }),
                  { status: 200, headers: { "content-type": "application/json" } }
                );
              }
              return new Response(runableToOpenAIStream(body, upstream, init?.signal), {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              });
            }

            lastStatus = upstream.status;
            lastMsg =
              {
                401: "Runable session expired",
                402: "Runable credits exhausted",
                403: "Runable denied this request",
                429: "Runable rate limited this request",
              }[upstream.status] || `Runable returned HTTP ${upstream.status}`;

            if ([401, 402, 403, 429].includes(upstream.status)) {
              POOL.fail(token, upstream.status);
              try {
                await upstream.body?.cancel();
              } catch {}
              continue; // try the next account
            }
            break; // non-account error: don't burn the other tokens
          }

          const benched = POOL.benchInfo();
          const detail = benched.length ? ` (benched: ${benched.join(", ")})` : "";
          return new Response(
            JSON.stringify({
              error: {
                message: `${lastMsg}. tried ${tried.length}/${POOL.tokens.length} account(s)${detail}`,
                type: "upstream_error",
              },
            }),
            { status: lastStatus || 429, headers: { "content-type": "application/json" } }
          );
        }

        return { baseURL: BASE, apiKey: tokens[0], fetch: runableFetch };
      },

      async usage(getAuth) {
        const auth = await getAuth?.();
        if (!auth) return { plan: "Runable", windows: [] };
        const total = POOL.tokens.length;
        const live = POOL.alive().length;
        return {
          plan: `Runable free (${live}/${total} accounts alive)`,
          windows: POOL.benchInfo().map((b) => ({ label: b, used: 0, limit: 0 })),
        };
      },
    },
  };
}

export default RunablePlugin;
