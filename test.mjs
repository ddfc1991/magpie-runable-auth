import { RunablePlugin } from "./index.mjs";

let fails = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fails++; };

const plugin = await RunablePlugin();
const auth = plugin.auth.methods[0];

// ---------- 1. config
const cfg = {};
await plugin.config(cfg);
const p = cfg.provider.runable;
const ids = Object.keys(p.models);
ok(!!p, "provider 'runable' registered");
ok(ids.length === 3, "only 3 free models (" + ids.length + ")");
ok(!ids.some((i) => /opus|fable/i.test(i)), "no paid models (opus/fable excluded)");
ok(ids.every((i) => p.models[i].cost.input === 0), "all models cost 0");
ok(ids.includes("anthropic/claude-sonnet-5.5"), "sonnet-5.5 present");
ok(ids.includes("anthropic/claude-haiku-5.5"), "haiku-5.5 present");

// ---------- 2. multi-token parsing
const a = await auth.authorize({ token: "tok-aaaaaaaa\n tok-bbbbbbbb\nBearer tok-cccccccc\ntok-aaaaaaaa" });
ok(a.type === "success", "authorize accepts multiple tokens");
ok(a.key.split("\n").length === 3, "dedupes + strips Bearer -> 3 tokens (" + a.key.split("\n").length + ")");
ok(!/Bearer/.test(a.key), "no 'Bearer' left in stored tokens");
const bad = await auth.authorize({ token: "   " });
ok(bad.type === "failed", "blank token rejected");

// ---------- 3. loader
const TOK = "tok-1-aaaaaaaa tok-2-bbbbbbbb tok-3-cccccccc";
const loaded = await plugin.auth.loader(async () => ({ key: TOK.replace(/ /g, "\n") }));
ok(typeof loaded.fetch === "function", "loader returns custom fetch");

// ---------- helpers to mock upstream
const realFetch = globalThis.fetch;
let calls = [];
function mockUpstream(handler) {
  globalThis.fetch = async (url, init) => {
    const tok = String(init.headers.Authorization).replace("Bearer ", "");
    calls.push({ tok, url, body: JSON.parse(init.body) });
    return handler(tok, calls.length);
  };
}
const SSE_OK =
  'data: {"type":"text-delta","delta":"你好"}\n\n' +
  'data: {"type":"reasoning-delta","delta":"想"}\n\n' +
  'data: {"type":"text-delta","delta":"，世界"}\n\n' +
  'data: {"type":"finish"}\n\n';
const reqBody = (over = {}) => JSON.stringify({
  model: "anthropic/claude-sonnet-5.5",
  stream: true,
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

// ---------- 4. streaming translation
calls = [];
mockUpstream(() => new Response(SSE_OK.replace(/nihao/g, ""), { status: 200 }));
let res = await loaded.fetch("x", { method: "POST", body: reqBody() });
let text = await res.text();
ok(res.status === 200, "stream: HTTP 200");
ok(text.includes('"content":"你好"') && text.includes('"content":"，世界"'), "stream: text deltas forwarded");
ok(text.includes('"reasoning_content":"想"'), "stream: reasoning forwarded");
ok(text.trim().endsWith("data: [DONE]"), "stream: ends with [DONE]");

// ---------- 5. rotation on 401 (fresh token set -> pool resets, cursor at 0)
calls = [];
const DEAD = "rot-1-deaddead";
const LIVE = "rot-2-livelive";
const rot = await plugin.auth.loader(async () => ({ key: DEAD + " " + LIVE }));
mockUpstream((tok) => (tok === DEAD ? new Response("no", { status: 401 }) : new Response(SSE_OK, { status: 200 })));
res = await rot.fetch("x", { method: "POST", body: reqBody() });
text = await res.text();
ok(res.status === 200, "rotation: succeeds on 2nd account after 401");
ok(calls.length === 2, "rotation: exactly 2 upstream calls (" + calls.length + ")");
ok(calls[0].tok !== calls[1].tok, "rotation: used two different tokens");
ok(text.includes("你好"), "rotation: streamed content from live account");

// ---------- 6. dead token is now benched (skipped)
calls = [];
res = await rot.fetch("x", { method: "POST", body: reqBody() });
await res.text();
ok(!calls.some((c) => c.tok === DEAD), "benched 401 token is skipped on later calls");
ok(calls.length === 1, "benched: only one upstream call (" + calls.length + ")");

// ---------- 7. all accounts dead -> actionable error
calls = [];
mockUpstream(() => new Response("no", { status: 401 }));
const fresh = await plugin.auth.loader(async () => ({ key: "tok-x-11111111 tok-x-22222222" }));
const deadRes = await fresh.fetch("x", { method: "POST", body: reqBody() });
const deadJson = await deadRes.json();
ok(deadRes.status === 401, "all-dead: 401 status");
ok(/tried \d+\/2 account/.test(deadJson.error.message), "all-dead: reports accounts tried");
ok(/benched/.test(deadJson.error.message), "all-dead: reports bench state");

// ---------- 8. free-model gate (fresh healthy pool)
calls = [];
const good = await plugin.auth.loader(async () => ({ key: "good-1-aaaaaaa good-2-bbbbbbb" }));
mockUpstream(() => new Response(SSE_OK, { status: 200 }));
const paid = await good.fetch("x", { method: "POST", body: reqBody({ model: "anthropic/claude-opus-5.5" }) });
const paidJson = await paid.json();
ok(paid.status === 400, "paid model rejected 400");
ok(/not a free Runable model/.test(paidJson.error.message), "rejection says free-only");

// ---------- 9. provider prefix stripped
calls = [];
mockUpstream(() => new Response(SSE_OK, { status: 200 }));
await (await good.fetch("x", { method: "POST", body: reqBody({ model: "runable/anthropic/claude-haiku-5.5" }) })).text();
ok(calls[0].body.modelId === "anthropic/claude-haiku-5.5", "gateway prefix 'runable/' stripped");

// ---------- 10. 8000-char cap
calls = [];
mockUpstream(() => new Response(SSE_OK, { status: 200 }));
const huge = "A".repeat(20000);
await (await good.fetch("x", { method: "POST", body: reqBody({ messages: [{ role: "user", content: huge }] }) })).text();
const sent = calls[0].body.message.parts[0].text;
ok(sent.length <= 7800, "long prompt capped at 7800 chars (" + sent.length + ")");
ok(/truncated/.test(sent), "truncation marker present");

// ---------- 11. non-streaming
calls = [];
mockUpstream(() => new Response(SSE_OK, { status: 200 }));
const ns = await (await good.fetch("x", { method: "POST", body: reqBody({ stream: false }) })).json();
ok(ns.choices[0].message.content === "你好，世界", "non-stream: assembled text");
ok(ns.choices[0].finish_reason === "stop", "non-stream: finish_reason stop");

// ---------- 12. multi-turn flatten
calls = [];
mockUpstream(() => new Response(SSE_OK, { status: 200 }));
await (await good.fetch("x", { method: "POST", body: reqBody({
  messages: [
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hey" },
    { role: "user", content: [{ type: "text", text: "more" }] },
  ],
}) })).text();
const flat = calls[0].body.message.parts[0].text;
ok(flat.includes("[system]\nbe terse") && flat.includes("[assistant]\nhey") && flat.includes("more"), "multi-turn flattened with roles");

globalThis.fetch = realFetch;
console.log(fails === 0 ? "\nALL GREEN" : "\n" + fails + " FAILED");
process.exit(fails === 0 ? 0 : 1);
