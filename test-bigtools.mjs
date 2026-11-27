import { RunablePlugin } from "./index.mjs";

let lastText = "";
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body);
  lastText = b.message.parts[0].text;
  return new Response('event: run\ndata: {"type":"text-delta","delta":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } });
};
const plugin = await RunablePlugin();
const p = await plugin.auth.loader(async () => ({ key: "big-tools-token-1234" }));

// 40 个工具（Magpie Agent 常带这么多）+ 30000 字符历史
const tools = Array.from({ length: 40 }, (_, i) => ({
  type: "function",
  function: { name: `tool_${i}`, description: "x".repeat(200), parameters: { type: "object", properties: {} } },
}));
const messages = [
  { role: "system", content: "y".repeat(20000) },
  { role: "user", content: "z".repeat(10000) },
];
const res = await p.fetch("x", {
  method: "POST",
  body: JSON.stringify({ model: "anthropic/claude-haiku-5.5", messages, tools, stream: false }),
});
await res.text();
console.log("upstream text length:", lastText.length);
console.log(lastText.length <= 7800 ? "PASS <= 7800 (no PROMPT_LIMIT_EXCEEDED)" : "FAIL still over limit");
process.exit(lastText.length <= 7800 ? 0 : 1);
