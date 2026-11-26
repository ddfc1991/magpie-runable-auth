import { RunablePlugin } from "./index.mjs";

const T1 = "acct-one-0123456789abcdef";
const T2 = "acct-two-fedcba9876543210";

const calls = [];
globalThis.fetch = async (url, init) => {
  const h = init?.headers || {};
  const auth = String(h.Authorization || h.authorization || "");
  calls.push(auth);
  const body =
    'event: text-delta\ndata: {"delta":"ok"}\n\nevent: finish\ndata: {"finishReason":"stop"}\n\n';
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const plugin = await RunablePlugin();
const provider = await plugin.auth.loader(async () => ({ key: T1 + "\n" + T2 }));
if (!provider.fetch) {
  console.error("loader shape:", Object.keys(provider));
  process.exit(1);
}

const body = () =>
  JSON.stringify({
    model: "anthropic/claude-haiku-5.5",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

for (let i = 0; i < 4; i++) await provider.fetch("x", { method: "POST", body: body() });

const c1 = calls.filter((a) => a.includes(T1)).length;
const c2 = calls.filter((a) => a.includes(T2)).length;
console.log((c1 === 2 && c2 === 2 ? "PASS" : "FAIL") + ` balanced 2/2 -> ${c1}/${c2}`);

const u = await plugin.auth.usage(async () => ({ key: T1 + "\n" + T2 }));
console.log("plan:", u.plan);
for (const w of u.windows) console.log("  -", w.name, "|", w.display);
