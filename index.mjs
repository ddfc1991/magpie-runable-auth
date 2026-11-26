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
// 本地计数口径：一个号一天大致能用的免费调用量（仅用于进度条，不是官方额度）
const DAILY_SOFT_CAP = 1500;

function parseTokens(raw) {
  if (!raw) return [];
  const list = String(raw)
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^Bearer\s+/i, ""))
    .filter((s) => s.length >= 8);
  return [...new Set(list)];
}

function newStats() {
  return { ok: 0, fail: 0, inTok: 0, outTok: 0, chars: 0, lastUsed: 0, lastStatus: 0, lastError: "" };
}

const POOL = {
  tokens: [],
  bench: new Map(), // token -> { until, status }
  stats: new Map(), // token -> { ok, fail, inTok, outTok, chars, lastUsed, lastStatus, lastError }
  callLog: [], // 最近 50 次调用：{ at, model, ms, status, who, ok }

  load(raw) {
    const next = parseTokens(raw);
    if (next.join() !== this.tokens.join()) {
      const prev = this.stats;
      this.tokens = next;
      this.bench = new Map();
      this.stats = new Map(next.map((t) => [t, prev.get(t) || newStats()]));
    }
  },
  alive() {
    const now = Date.now();
    return this.tokens.filter((t) => {
      const b = this.bench.get(t);
      return !b || b.until <= now;
    });
  },
  // 自动切换：优先挑「用得最少、且最久没用」的号；停用中的自动跳过
  pick() {
    const live = this.alive();
    if (!live.length) return null;
    let best = live[0];
    let bestUsed = Infinity;
    let bestLast = Infinity;
    for (const t of live) {
      const s = this.stats.get(t) || newStats();
      const used = s.ok + s.fail;
      if (used < bestUsed || (used === bestUsed && s.lastUsed < bestLast)) {
        best = t;
        bestUsed = used;
        bestLast = s.lastUsed;
      }
    }
    return best;
  },
  ok(token, info) {
    const s = this.stats.get(token) || newStats();
    s.ok++;
    s.lastUsed = Date.now();
    s.lastStatus = 200;
    s.lastError = "";
    if (info) {
      if (info.inTok) s.inTok += info.inTok;
      if (info.outTok) s.outTok += info.outTok;
      if (info.chars) s.chars += info.chars;
    }
    this.stats.set(token, s);
    this.log({ ok: true, status: 200, who: this.mask(token), model: info?.model, ms: info?.ms });
  },
  fail(token, status, info) {
    const s = this.stats.get(token) || newStats();
    s.fail++;
    s.lastUsed = Date.now();
    s.lastStatus = status;
    s.lastError = info?.error || "";
    this.stats.set(token, s);
    const ms = BENCH_MS[status];
    if (ms) this.bench.set(token, { until: Date.now() + ms, status });
    this.log({ ok: false, status, who: this.mask(token), model: info?.model, ms: info?.ms, error: s.lastError });
  },
  log(entry) {
    this.callLog.unshift({ at: Date.now(), ...entry });
    if (this.callLog.length > 50) this.callLog.length = 50;
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
  // 每个号的用量快照（给 Magpie 账号页展示）
  report() {
    const now = Date.now();
    return this.tokens.map((t, i) => {
      const s = this.stats.get(t) || newStats();
      const b = this.bench.get(t);
      const benched = b && b.until > now ? Math.ceil((b.until - now) / 1000) : 0;
      return { index: i + 1, who: this.mask(t), ...s, benched };
    });
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
          const startedAt = Date.now();

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
              POOL.ok(token, { model, ms: Date.now() - startedAt, chars: 0 });
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
              POOL.fail(token, upstream.status, { model, ms: Date.now() - startedAt, error: lastMsg });
              try {
                await upstream.body?.cancel();
              } catch {}
              continue; // try the next account
            }
            break; // non-account error: don't burn the other tokens
          }

          const benched = POOL.benchInfo();
          const detail = benched.length ? ` (benched: ${benched.join(", ")})` : "";

          // Single-token credential (= one Magpie account): a 401 means this
          // account's login died. Flag it so Magpie marks it "needs sign-in"
          // instead of silently retrying forever.
          if (lastStatus === 401 && POOL.tokens.length === 1) {
            const err = new Error(
              "Runable 登录态已失效（401），请在 Magpie 里重新登录这个账号"
            );
            err.signIn = "expired";
            throw err;
          }

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
        POOL.load(auth.key);
        const rows = POOL.report();
        const live = rows.filter((r) => !r.benched).length;
        const now = Date.now();
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        const credit = await fetchCreditSnapshot();
        const planBits = [`Runable free · ${live}/${rows.length} 号可用`];
        if (credit && credit.available != null) {
          planBits.push(`网页积分 ${credit.available}${credit.dailyLimit ? "/" + credit.dailyLimit : ""}`);
        } else {
          planBits.push("本地计数");
        }
        return {
          plan: planBits.join(" · "),
          windows: rows.map((r) => {
            const used = r.ok + r.fail;
            const pct = Math.min(100, Math.round((used / DAILY_SOFT_CAP) * 100));
            const bits = [];
            if (credit && credit.available != null) {
              bits.push(`积分 ${credit.available}${credit.dailyLimit ? "/" + credit.dailyLimit : ""}`);
            }
            bits.push(`${used} 次调用`, `成 ${r.ok} / 败 ${r.fail}`);
            if (r.outTok) bits.push(`${r.outTok} tok`);
            if (r.chars) bits.push(`${(r.chars / 1000).toFixed(1)}k 字`);
            bits.push(
              r.lastUsed ? `最近 ${Math.max(0, Math.round((now - r.lastUsed) / 60000))} 分钟前` : "未使用"
            );
            if (r.benched) bits.push(`停用 ${r.benched}s（HTTP${r.lastStatus}）`);
            return {
              name: `号${r.index} ${r.who}`,
              used: pct,
              resetsAt: midnight.toISOString(),
              span: 86400,
              display: bits.join(" · "),
            };
          }),
        };
      },
    },
  };
}

export default RunablePlugin;

// 读取网页积分快照（由沙箱侧的 credit-bridge 提供，来源=Edge 里登录的号）
async function fetchCreditSnapshot() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch("http://127.0.0.1:8899/runable/credits", { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || j.available == null) return null;
    return { available: j.available, dailyLimit: j.dailyLimit || j.todayLimit || null, at: j.at || null };
  } catch {
    return null;
  }
}
