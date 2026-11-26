import { RunablePlugin } from "./index.mjs";

const plugin = await RunablePlugin();
const realFetch = globalThis.fetch;

globalThis.fetch = async () =>
  new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });

const loaded = await plugin.auth.loader(async () => ({ key: "tok-single" }));

let ok = false;
try {
  await loaded.fetch("x", {
    method: "POST",
    body: JSON.stringify({
      model: "anthropic/claude-haiku-5.5",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  console.log("FAIL: no throw");
} catch (e) {
  ok = e?.signIn === "expired";
  console.log(ok ? "PASS single-token 401 -> signIn=expired" : "FAIL: " + e?.message);
}

globalThis.fetch = realFetch;
process.exit(ok ? 0 : 1);
